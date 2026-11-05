/**
 * Deploys Podmatic and writes addresses for the web app.
 *
 *  - localhost / hardhat: deploys mock USDC, a demo collection, a mock randomness provider, and seeds a full demo
 *    (bids, two machines, LP, consigned NFTs, market-making orders, odds listings, a few spins).
 *  - sepolia / baseSepolia: deploys the core with real USDC and Chainlink VRF v2.5. Set DEMO=1 to also deploy and
 *    register a demo collection minted to the deployer.
 *  - mainnet / base: same as testnets, but refuses to run unless ALLOW_MAINNET=1. The contracts are not audited.
 *
 * Environment for public networks: PRIVATE_KEY, VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUBSCRIPTION_ID,
 * optional USDC_ADDRESS, TREASURY, *_RPC_URL. See https://docs.chain.link/vrf/v2-5/supported-networks.
 */
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import { buildDemoCollection, traitKey, COLLECTION_TRAIT, DemoCollection } from "./lib/demoCollection";

// Circle-issued USDC. Verify before mainnet use; override with USDC_ADDRESS.
const USDC: Record<number, string> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const WEB_GENERATED = path.join(__dirname, "..", "..", "web", "src", "generated");
const usdc = (n: number) => ethers.parseUnits(n.toString(), 6);

type Deployment = {
  chainId: number;
  network: string;
  quote: string;
  registry: string;
  bidBook: string;
  floorBook: string;
  factory: string;
  odds: string;
  randomness: string;
  randomnessKind: "mock" | "chainlink";
  demoCollection?: string;
  deployedAt: string;
};

async function main() {
  const chainId = Number(network.config.chainId);
  const isLocal = chainId === 31337;
  if ((chainId === 1 || chainId === 8453) && process.env.ALLOW_MAINNET !== "1") {
    throw new Error("Refusing to deploy to mainnet without ALLOW_MAINNET=1. The contracts are not audited.");
  }
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY ?? deployer.address;
  console.log(`Deploying to ${network.name} (${chainId}) from ${deployer.address}`);

  // Quote token
  let quoteAddr: string;
  if (isLocal) {
    quoteAddr = await (await ethers.deployContract("MockUSDC")).getAddress();
  } else {
    quoteAddr = process.env.USDC_ADDRESS ?? USDC[chainId];
    if (!quoteAddr) throw new Error(`No USDC address for chain ${chainId}; set USDC_ADDRESS`);
  }

  // Randomness
  let randomnessAddr: string;
  let randomnessKind: Deployment["randomnessKind"];
  if (isLocal) {
    randomnessAddr = await (await ethers.deployContract("MockRandomnessProvider")).getAddress();
    randomnessKind = "mock";
  } else {
    const { VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUBSCRIPTION_ID } = process.env;
    if (!VRF_COORDINATOR || !VRF_KEY_HASH || !VRF_SUBSCRIPTION_ID) {
      throw new Error("Set VRF_COORDINATOR, VRF_KEY_HASH and VRF_SUBSCRIPTION_ID for Chainlink VRF v2.5");
    }
    const provider = await ethers.deployContract("ChainlinkVRFProvider", [
      VRF_COORDINATOR, VRF_KEY_HASH, BigInt(VRF_SUBSCRIPTION_ID), 3, 1_000_000, deployer.address,
    ]);
    randomnessAddr = await provider.getAddress();
    randomnessKind = "chainlink";
  }

  const registry = await ethers.deployContract("CollectionRegistry", [deployer.address]);
  const bidBook = await ethers.deployContract("BidBook", [quoteAddr, await registry.getAddress(), treasury, deployer.address]);
  const floorBook = await ethers.deployContract("FloorBook", [quoteAddr, await registry.getAddress(), treasury]);
  const impl = await ethers.deployContract("Machine");
  const factory = await ethers.deployContract("MachineFactory", [
    await impl.getAddress(), quoteAddr, await registry.getAddress(), await bidBook.getAddress(), randomnessAddr, treasury,
  ]);
  await (await bidBook.setMachineRegistry(await factory.getAddress())).wait();
  const odds = await ethers.deployContract("OddsMarket", [quoteAddr, await registry.getAddress(), randomnessAddr, treasury]);

  if (randomnessKind === "chainlink") {
    const provider = await ethers.getContractAt("ChainlinkVRFProvider", randomnessAddr);
    await (await provider.setAuthorizer(await factory.getAddress(), true)).wait();
    await (await provider.setConsumer(await odds.getAddress(), true)).wait();
    console.log(`Add ${randomnessAddr} as a consumer of VRF subscription ${process.env.VRF_SUBSCRIPTION_ID}.`);
  }

  const deployment: Deployment = {
    chainId,
    network: network.name,
    quote: quoteAddr,
    registry: await registry.getAddress(),
    bidBook: await bidBook.getAddress(),
    floorBook: await floorBook.getAddress(),
    factory: await factory.getAddress(),
    odds: await odds.getAddress(),
    randomness: randomnessAddr,
    randomnessKind,
    deployedAt: new Date().toISOString(),
  };

  if (isLocal || process.env.DEMO === "1") {
    const demo = buildDemoCollection(200);
    const nft = await ethers.deployContract("MockCollection", ["Pod Apes", "PAPE", ""]);
    const nftAddr = await nft.getAddress();
    await (await registry.register(nftAddr, "Pod Apes", demo.root)).wait();
    await (await registry.setTraitCounts(nftAddr, Object.keys(demo.counts), Object.values(demo.counts))).wait();
    deployment.demoCollection = nftAddr;
    writeCollection(chainId, nftAddr, demo);
    if (isLocal) {
      await seedLocal(deployment, demo);
    } else {
      await (await nft.mint(deployer.address, 50)).wait();
    }
  }

  writeDeployment(deployment);
  console.log(JSON.stringify(deployment, null, 2));
}

function writeDeployment(d: Deployment) {
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${d.network}.json`), JSON.stringify(d, null, 2));
  fs.mkdirSync(WEB_GENERATED, { recursive: true });
  fs.writeFileSync(path.join(WEB_GENERATED, `deployment.${d.chainId}.json`), JSON.stringify(d, null, 2));
}

function writeCollection(chainId: number, address: string, demo: DemoCollection) {
  fs.mkdirSync(WEB_GENERATED, { recursive: true });
  const out = { chainId, address, name: "Pod Apes", ...demo };
  fs.writeFileSync(path.join(WEB_GENERATED, `collection.${chainId}.json`), JSON.stringify(out));
}

/** Best bid (by price) among `bids` that can value `tokenId`. */
function bestBidFor(demo: DemoCollection, tokenId: number, bids: { id: number; key: string; price: number }[]) {
  const keys = new Set(Object.keys(demo.proofs[tokenId]));
  let best: { id: number; key: string; price: number } | undefined;
  for (const b of bids) {
    if (b.key !== COLLECTION_TRAIT && !keys.has(b.key)) continue;
    if (!best || b.price > best.price) best = b;
  }
  return best!;
}

async function seedLocal(d: Deployment, demo: DemoCollection) {
  const signers = await ethers.getSigners();
  const [user, bidder, lp, s1, s2, s3, maker] = signers;
  const sellers = [s1, s2, s3];
  const quote = await ethers.getContractAt("MockUSDC", d.quote);
  const nft = await ethers.getContractAt("MockCollection", d.demoCollection!);
  const bidBook = await ethers.getContractAt("BidBook", d.bidBook);
  const floorBook = await ethers.getContractAt("FloorBook", d.floorBook);
  const factory = await ethers.getContractAt("MachineFactory", d.factory);
  const odds = await ethers.getContractAt("OddsMarket", d.odds);
  const randomness = await ethers.getContractAt("MockRandomnessProvider", d.randomness);
  const nftAddr = d.demoCollection!;

  console.log("Seeding local demo…");
  for (const s of [user, bidder, lp, ...sellers, maker]) await quote.mint(s.address, usdc(1_000_000));
  // Token ranges: user 0-39, sellers 40-159, maker 160-199.
  await nft.mint(user.address, 40);
  for (const s of sellers) await nft.mint(s.address, 40);
  await nft.mint(maker.address, 40);

  // Bids that price the collection. Prices follow the 50 USDC machine bands.
  await quote.connect(bidder).approve(d.bidBook, ethers.MaxUint256);
  await bidBook.connect(bidder).deposit(usdc(60_000));
  const bidSpecs: [string, number][] = [
    [COLLECTION_TRAIT, 20],
    [traitKey("Hat", "Beanie"), 38],
    [traitKey("Hat", "Cap"), 45],
    [traitKey("Eyes", "Laser"), 55],
    [traitKey("Fur", "White"), 62],
    [traitKey("Hat", "Crown"), 150],
    [traitKey("Hat", "Halo"), 420],
    [traitKey("Fur", "Gold"), 1200],
  ];
  const bids: { id: number; key: string; price: number }[] = [];
  for (const [key, price] of bidSpecs) {
    await bidBook.connect(bidder).placeBid(nftAddr, key, usdc(price), 100);
    bids.push({ id: bids.length, key, price });
  }
  // Bids must rest one day before they can value NFTs.
  await ethers.provider.send("evm_increaseTime", [24 * 3600 + 60]);
  await ethers.provider.send("evm_mine", []);

  const standard = [7198, 1804, 702, 271, 25];
  const chase = [8038, 1195, 498, 199, 70];
  const bands = [[10, 30], [30, 75], [75, 200], [200, 600], [600, 3000]];
  const tiers = (probs: number[]) =>
    bands.map(([lo, hi], i) => ({ minValue: usdc(lo), maxValue: usdc(hi), baseProbBps: probs[i] }));
  await factory.connect(maker).createMachine({
    nft: nftAddr, spinPrice: usdc(50), targetRtpBps: 8900, creatorFeeBps: 250, riskBps: 2500,
    tiers: tiers(standard), name: "Pod Apes · 标准机",
  });
  await factory.connect(maker).createMachine({
    nft: nftAddr, spinPrice: usdc(50), targetRtpBps: 8800, creatorFeeBps: 250, riskBps: 2500,
    tiers: tiers(chase), name: "Pod Apes · 追梦机",
  });
  const [m1Addr, m2Addr] = await factory.allMachines();
  const machines = [await ethers.getContractAt("Machine", m1Addr), await ethers.getContractAt("Machine", m2Addr)];

  await quote.connect(lp).approve(m1Addr, ethers.MaxUint256);
  await quote.connect(lp).approve(m2Addr, ethers.MaxUint256);
  await machines[0].connect(lp).deposit(usdc(60_000));
  await machines[1].connect(lp).deposit(usdc(40_000));

  // Sellers consign with a floor 5% under the bid, so every listing is in range.
  let tokenId = 40;
  for (const [mi, count] of [[0, 70], [1, 40]] as [number, number][]) {
    for (let i = 0; i < count; i++, tokenId++) {
      const seller = sellers[Math.floor((tokenId - 40) / 40)];
      const machine = machines[mi];
      const b = bestBidFor(demo, tokenId, bids);
      const proof = b.key === COLLECTION_TRAIT ? [] : demo.proofs[tokenId][b.key];
      await nft.connect(seller).setApprovalForAll(await machine.getAddress(), true);
      await machine.connect(seller).list(tokenId, usdc(Math.floor(b.price * 0.95)), b.key, proof);
      await machine.refreshValuation((await machine.listingCount()) - 1n, b.id);
    }
  }

  // Market-making orders for floor NFTs (maker deposits floor-only tokens).
  await quote.connect(maker).approve(d.floorBook, ethers.MaxUint256);
  await nft.connect(maker).setApprovalForAll(d.floorBook, true);
  const makerTokens = Array.from({ length: 40 }, (_, i) => 160 + i);
  const floorOnly = makerTokens.filter((id) => bestBidFor(demo, id, bids).key === COLLECTION_TRAIT);
  await floorBook.connect(maker).createOrder(nftAddr, usdc(22), 300, 400, usdc(2_000), floorOnly.slice(0, 8));
  await floorBook.connect(maker).createOrder(nftAddr, usdc(23.5), 500, 500, usdc(1_000), floorOnly.slice(8, 12));

  // Odds market: vault liquidity and a few rare NFTs listed with the seller's own ask.
  await quote.connect(lp).approve(d.odds, ethers.MaxUint256);
  await odds.connect(lp).deposit(usdc(120_000));
  const rare = makerTokens.filter((id) => bestBidFor(demo, id, bids).price >= 150).slice(0, 6);
  for (const id of rare) {
    const ask = Math.round(bestBidFor(demo, id, bids).price * 1.35);
    await nft.connect(maker).approve(d.odds, id);
    await odds.connect(maker).list(nftAddr, id, usdc(ask));
  }

  // A little history.
  await quote.connect(user).approve(m1Addr, ethers.MaxUint256);
  for (let i = 0; i < 3; i++) {
    const tx = await machines[0].connect(user).spin(ethers.ZeroAddress);
    const receipt = await tx.wait();
    const ev = receipt!.logs.map((l) => machines[0].interface.parseLog(l)).find((e) => e?.name === "SpinRequested");
    await randomness.fulfill(ev!.args.requestId);
  }
  console.log(`Seeded ${tokenId - 40} listings across 2 machines, ${bids.length} bids, 2 floor orders, ${rare.length} odds listings.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
