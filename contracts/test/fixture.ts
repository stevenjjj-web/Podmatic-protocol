import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { buildDemoCollection, traitKey, COLLECTION_TRAIT } from "../scripts/lib/demoCollection";

export const usdc = (n: number) => ethers.parseUnits(n.toString(), 6);
export const DAY = 24 * 60 * 60;

/** Tier bands for a 50 USDC machine, in single-pull multiples 0.2-0.6 / 0.6-1.5 / 1.5-4 / 4-12 / 12-60. */
export const TIERS = [
  { minValue: usdc(10), maxValue: usdc(30), baseProbBps: 7198 },
  { minValue: usdc(30), maxValue: usdc(75), baseProbBps: 1804 },
  { minValue: usdc(75), maxValue: usdc(200), baseProbBps: 702 },
  { minValue: usdc(200), maxValue: usdc(600), baseProbBps: 271 },
  { minValue: usdc(600), maxValue: usdc(3000), baseProbBps: 25 },
];

export async function deployCore() {
  const [owner, treasury, lp, seller, player, bidder, maker] = await ethers.getSigners();
  const demo = buildDemoCollection(120);

  const quote = await ethers.deployContract("MockUSDC");
  const nft = await ethers.deployContract("MockCollection", ["Pod Apes", "PAPE", "ipfs://demo/"]);
  const registry = await ethers.deployContract("CollectionRegistry", [owner.address]);
  await registry.register(await nft.getAddress(), "Pod Apes", demo.root);
  await registry.setTraitCounts(await nft.getAddress(), Object.keys(demo.counts), Object.values(demo.counts));

  const bidBook = await ethers.deployContract("BidBook", [
    await quote.getAddress(), await registry.getAddress(), treasury.address, owner.address,
  ]);
  const floorBook = await ethers.deployContract("FloorBook", [
    await quote.getAddress(), await registry.getAddress(), treasury.address,
  ]);
  const randomness = await ethers.deployContract("MockRandomnessProvider");
  const impl = await ethers.deployContract("Machine");
  const factory = await ethers.deployContract("MachineFactory", [
    await impl.getAddress(), await quote.getAddress(), await registry.getAddress(),
    await bidBook.getAddress(), await randomness.getAddress(), treasury.address,
  ]);
  await bidBook.setMachineRegistry(await factory.getAddress());
  const odds = await ethers.deployContract("OddsMarket", [
    await quote.getAddress(), await registry.getAddress(), await randomness.getAddress(), treasury.address,
  ]);

  for (const s of [lp, seller, player, bidder, maker]) await quote.mint(s.address, usdc(1_000_000));
  await nft.mint(seller.address, 120);

  return { owner, treasury, lp, seller, player, bidder, maker, demo, quote, nft, registry, bidBook, floorBook, randomness, factory, odds };
}

/** Pick tokens carrying a trait. */
export function tokensWith(demo: ReturnType<typeof buildDemoCollection>, type: string, value: string) {
  return demo.tokens.filter((t) => t.traits[type] === value).map((t) => t.tokenId);
}

export async function deployMachineWithInventory() {
  const core = await deployCore();
  const { factory, quote, nft, bidBook, seller, bidder, lp, demo } = core;

  await factory.createMachine({
    nft: await nft.getAddress(),
    spinPrice: usdc(50),
    targetRtpBps: 8900,
    creatorFeeBps: 250,
    riskBps: 2500,
    tiers: TIERS,
    name: "Pod Apes Standard",
  });
  const machine = await ethers.getContractAt("Machine", (await factory.allMachines())[0]);

  // Bids that will price listings: floor 20, Cap 45, Crown 150, Halo 450, Gold fur 1500.
  await quote.connect(bidder).approve(await bidBook.getAddress(), ethers.MaxUint256);
  await bidBook.connect(bidder).deposit(usdc(20_000));
  const bidSpecs: [string, number][] = [
    [COLLECTION_TRAIT, 20],
    [traitKey("Hat", "Cap"), 45],
    [traitKey("Hat", "Crown"), 150],
    [traitKey("Hat", "Halo"), 450],
    [traitKey("Fur", "Gold"), 1500],
  ];
  for (const [key, price] of bidSpecs) {
    await bidBook.connect(bidder).placeBid(await nft.getAddress(), key, usdc(price), 50);
  }
  await time.increase(DAY + 1);

  await quote.connect(lp).approve(await machine.getAddress(), ethers.MaxUint256);
  await machine.connect(lp).deposit(usdc(50_000));

  // Consign two tokens per trait and value them.
  await nft.connect(seller).setApprovalForAll(await machine.getAddress(), true);
  const picks: [string, string, number][] = [
    ["Hat", "None", 0], ["Hat", "Cap", 1], ["Hat", "Crown", 2], ["Hat", "Halo", 3], ["Fur", "Gold", 4],
  ];
  const used = new Set<number>();
  for (const [type, value, bidId] of picks) {
    const key = value === "None" ? COLLECTION_TRAIT : traitKey(type, value);
    const ids = tokensWith(demo, type, value).filter((id) => !used.has(id)).slice(0, 2);
    for (const id of ids) {
      used.add(id);
      const proof = key === COLLECTION_TRAIT ? [] : demo.proofs[id][key];
      await machine.connect(seller).list(id, usdc(1), key, proof);
      const listingId = (await machine.listingCount()) - 1n;
      await machine.refreshValuation(listingId, bidId);
    }
  }
  return { ...core, machine };
}
