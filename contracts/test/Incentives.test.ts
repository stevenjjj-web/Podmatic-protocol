import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { AbiCoder, keccak256 } from "ethers";
import { deployMachineWithInventory, deployPityMachine, usdc, DAY } from "./fixture";
import type { Machine } from "../typechain-types";

const ONE = 10n ** 18n;
const coder = AbiCoder.defaultAbiCoder();

/** Mirrors Machine._pickTier. */
function pickTier(probs: readonly bigint[], r: bigint): number {
  let acc = 0n;
  let last = 0;
  for (let k = 0; k < probs.length; k++) {
    if (probs[k] === 0n) continue;
    acc += probs[k];
    last = k;
    if (r < acc) return k;
  }
  return last;
}

/** Finds a random word whose first draw attempt picks a listing satisfying `want`. */
async function wordFor(machine: Machine, player: string, want: (tier: number, listingId: bigint) => boolean) {
  const [odds] = await machine.previewOddsFor(player);
  const pools: Record<number, readonly bigint[]> = {};
  for (let w = 1n; w < 50_000n; w++) {
    const r = BigInt(keccak256(coder.encode(["uint256", "uint256"], [w, 0])));
    const tier = pickTier(odds.probs, r % ONE);
    pools[tier] ??= await machine.tierListings(tier);
    const pool = pools[tier];
    const id = pool[Number((r / ONE) % BigInt(pool.length))];
    if (want(tier, id)) return w;
  }
  throw new Error("no word found");
}

async function spinWith(machine: Machine, randomness: { fulfillWith: (id: bigint, w: bigint) => Promise<unknown> }, player: any, word: bigint) {
  const tx = await machine.connect(player).spin(ethers.ZeroAddress);
  const receipt = await tx.wait();
  const req = receipt!.logs.map((l) => { try { return machine.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "SpinRequested");
  const fr = await (await (randomness as any).fulfillWith(req!.args.requestId, word)).wait();
  const settled = fr!.logs.map((l: any) => { try { return machine.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "SpinSettled");
  return settled?.args as undefined | { tokenId: bigint; tier: bigint; value: bigint; listingId: bigint; pity: boolean };
}

describe("Inventory yield", () => {
  it("allocates 1.5% of each spin to drawable listings, pro rata within tiers", async () => {
    const { machine, randomness, quote, player } = await loadFixture(deployMachineWithInventory);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    await spinWith(machine, randomness as any, player, 42n);

    const liability = await machine.yieldLiability();
    expect(liability).to.be.closeTo(usdc(0.75), 10n); // 1.5% of 50 USDC, rounding dust aside
    let pending = 0n;
    for (let i = 0n; i < (await machine.listingCount()); i++) pending += await machine.pendingYieldOf(i);
    expect(pending).to.be.lte(liability);
    expect(liability - pending).to.be.lt(100n);
    // Two listings in the same tier with the same value earn the same.
    const t0 = await machine.tierListings(0);
    if (t0.length === 2) expect(await machine.pendingYieldOf(t0[0])).to.equal(await machine.pendingYieldOf(t0[1]));
  });

  it("vests for 3 days, pays on claim, and is forfeited on an early delist", async () => {
    const { machine, randomness, quote, player, seller } = await loadFixture(deployMachineWithInventory);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    for (let i = 0; i < 3; i++) await spinWith(machine, randomness as any, player, BigInt(1000 + i));

    const active = [...(await machine.tierListings(1)), ...(await machine.tierListings(2))];
    const [a, b] = active;
    expect(await machine.pendingYieldOf(a)).to.be.gt(0n);
    await expect(machine.connect(seller).claimYield(a)).to.be.revertedWith("vesting");

    await time.increase(3 * DAY + 1);
    const owed = await machine.pendingYieldOf(a);
    const before = await quote.balanceOf(seller.address);
    await machine.connect(seller).claimYield(a);
    expect((await quote.balanceOf(seller.address)) - before).to.equal(owed);

    // Delisting before 7 days forfeits yield back to LPs.
    const forfeited = await machine.pendingYieldOf(b);
    const assetsBefore = await machine.totalAssets();
    await expect(machine.connect(seller).delist(b)).to.emit(machine, "Delisted").withArgs(b, 0n, forfeited);
    expect((await machine.totalAssets()) - assetsBefore).to.equal(forfeited);
  });

  it("pays accrued yield to the seller when the listing is drawn", async () => {
    // Plenty of floor listings so the machine stays open across several spins.
    const { machine, randomness, quote, player, seller } = await loadFixture(deployPityMachine);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    for (let i = 0; i < 3; i++) await spinWith(machine, randomness as any, player, BigInt(2000 + i));
    const target = (await machine.tierListings(1))[0];
    const owed = await machine.pendingYieldOf(target);
    expect(owed).to.be.gt(0n);
    const word = await wordFor(machine, player.address, (_, id) => id === target);
    const before = await quote.balanceOf(seller.address);
    const s = await spinWith(machine, randomness as any, player, word);
    expect(s!.listingId).to.equal(target);
    expect((await quote.balanceOf(seller.address)) - before).to.equal((s!.value * 10150n) / 10000n + owed);
  });
});

describe("Circulation royalty", () => {
  it("pays the first consignor 1% of V when someone else re-consigns and sells the NFT", async () => {
    const { machine, randomness, quote, nft, player, seller, demo } = await loadFixture(deployMachineWithInventory);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    const crownListing = (await machine.tierListings(2))[0];
    const first = await spinWith(machine, randomness as any, player, await wordFor(machine, player.address, (_, id) => id === crownListing));
    expect(await nft.ownerOf(first!.tokenId)).to.equal(player.address);
    expect(await machine.firstConsignor(first!.tokenId)).to.equal(seller.address);

    // The winner consigns it back; same trait and bid value it.
    const l = await machine.listings(first!.listingId);
    await nft.connect(player).setApprovalForAll(await machine.getAddress(), true);
    await machine.connect(player).list(first!.tokenId, usdc(1), l.traitKey, demo.proofs[Number(first!.tokenId)][l.traitKey]);
    const relist = (await machine.listingCount()) - 1n;
    await machine.refreshValuation(relist, l.bidId);

    const sellerBefore = await quote.balanceOf(seller.address);
    const playerBefore = await quote.balanceOf(player.address);
    const word = await wordFor(machine, player.address, (_, id) => id === relist);
    const tx = await machine.connect(player).spin(ethers.ZeroAddress);
    const req = (await tx.wait())!.logs.map((x) => machine.interface.parseLog(x)).find((e) => e?.name === "SpinRequested")!;
    await expect((randomness as any).fulfillWith(req.args.requestId, word))
      .to.emit(machine, "RoyaltyPaid")
      .withArgs(relist, seller.address, (l.value * 100n) / 10000n);
    expect((await quote.balanceOf(seller.address)) - sellerBefore).to.equal((l.value * 100n) / 10000n);
    // Player paid the spin price and received V * (1.015 - 0.01) as the selling consignor.
    expect((await quote.balanceOf(player.address)) - playerBefore).to.equal((l.value * 10050n) / 10000n - usdc(50));
  });
});

describe("Pity", () => {
  async function missUntilDue(machine: Machine, randomness: any, player: any, threshold: number) {
    for (let i = 0; i < threshold; i++) {
      const w = await wordFor(machine, player.address, (tier) => tier === 0);
      const s = await spinWith(machine, randomness, player, w);
      expect(s!.tier).to.equal(0n);
    }
    expect(await machine.pityCount(player.address)).to.equal(BigInt(threshold));
  }

  it("after the threshold, draws only rare-or-better and the pity pool pays the extra cost", async () => {
    const { machine, randomness, quote, player, owner } = await loadFixture(deployPityMachine);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    await quote.mint(owner.address, usdc(1000));
    await quote.connect(owner).approve(await machine.getAddress(), ethers.MaxUint256);
    await machine.connect(owner).fundPity(usdc(500));

    await missUntilDue(machine, randomness, player, 20);
    const [, due] = await machine.previewOddsFor(player.address);
    expect(due).to.equal(true);
    const poolBefore = await machine.pityPool();
    const s = await spinWith(machine, randomness, player, 777n);
    expect(s!.pity).to.equal(true);
    expect(s!.tier).to.be.gte(2n);
    expect(await machine.pityCount(player.address)).to.equal(0n);
    // Pool: +0.5 USDC from this spin, minus the extra expected cost of the pity draw.
    expect(await machine.pityPool()).to.be.lt(poolBefore);
  });

  it("does not trigger when the pity pool cannot pay for it", async () => {
    const { machine, randomness, quote, player } = await loadFixture(deployPityMachine);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    await missUntilDue(machine, randomness, player, 20);
    const [, due] = await machine.previewOddsFor(player.address);
    expect(due).to.equal(false); // 20 spins put only 10 USDC in the pool
    const s = await spinWith(machine, randomness, player, await wordFor(machine, player.address, (tier) => tier === 0));
    expect(s!.pity).to.equal(false);
    expect(await machine.pityCount(player.address)).to.equal(21n);
  });
});
