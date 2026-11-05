import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployCore, deployMachineWithInventory, usdc, DAY, tokensWith, TIERS } from "./fixture";
import { traitKey, COLLECTION_TRAIT } from "../scripts/lib/demoCollection";

describe("CollectionRegistry", () => {
  it("verifies snapshot traits and rejects wrong ones", async () => {
    const { registry, nft, demo } = await loadFixture(deployCore);
    const crown = traitKey("Hat", "Crown");
    const id = tokensWith(demo, "Hat", "Crown")[0];
    const other = tokensWith(demo, "Hat", "None")[0];
    const addr = await nft.getAddress();
    expect(await registry.verifyTrait(addr, id, crown, demo.proofs[id][crown])).to.equal(true);
    expect(await registry.verifyTrait(addr, other, crown, demo.proofs[id][crown])).to.equal(false);
    expect(await registry.verifyTrait(addr, other, COLLECTION_TRAIT, [])).to.equal(true);
  });
});

describe("BidBook", () => {
  it("fills a trait bid with a proof and charges the taker fee", async () => {
    const { bidBook, quote, nft, seller, bidder, treasury, demo } = await loadFixture(deployCore);
    const crown = traitKey("Hat", "Crown");
    await quote.connect(bidder).approve(await bidBook.getAddress(), ethers.MaxUint256);
    await bidBook.connect(bidder).deposit(usdc(1000));
    await bidBook.connect(bidder).placeBid(await nft.getAddress(), crown, usdc(150), 2);

    const id = tokensWith(demo, "Hat", "Crown")[0];
    await nft.connect(seller).approve(await bidBook.getAddress(), id);
    const before = await quote.balanceOf(seller.address);
    await bidBook.connect(seller).fill(0, id, demo.proofs[id][crown], usdc(150));

    expect(await nft.ownerOf(id)).to.equal(bidder.address);
    expect((await quote.balanceOf(seller.address)) - before).to.equal(usdc(148.5));
    expect(await quote.balanceOf(treasury.address)).to.equal(usdc(1.5));
    expect(await bidBook.balanceOf(bidder.address)).to.equal(usdc(850));
  });

  it("shares one escrow across bids and only counts aged, funded bids for valuation", async () => {
    const { bidBook, quote, nft, bidder } = await loadFixture(deployCore);
    const addr = await nft.getAddress();
    await quote.connect(bidder).approve(await bidBook.getAddress(), ethers.MaxUint256);
    await bidBook.connect(bidder).deposit(usdc(200));
    await bidBook.connect(bidder).placeBid(addr, COLLECTION_TRAIT, usdc(20), 10);
    await bidBook.connect(bidder).placeBid(addr, traitKey("Hat", "Crown"), usdc(150), 10);
    await bidBook.connect(bidder).placeBid(addr, traitKey("Fur", "Gold"), usdc(500), 10);

    expect(await bidBook.isValuationEligible(0, addr, COLLECTION_TRAIT)).to.equal(false); // too young
    await time.increase(DAY + 1);
    expect(await bidBook.isValuationEligible(0, addr, COLLECTION_TRAIT)).to.equal(true);
    expect(await bidBook.isValuationEligible(1, addr, traitKey("Hat", "Crown"))).to.equal(true);
    expect(await bidBook.isValuationEligible(2, addr, traitKey("Fur", "Gold"))).to.equal(false); // underfunded
    // A trait bid cannot value a token that lacks the trait.
    expect(await bidBook.isValuationEligible(1, addr, traitKey("Hat", "Cap"))).to.equal(false);

    // Raising a price restarts the age clock; lowering keeps it.
    await bidBook.connect(bidder).updateBid(0, usdc(25), 10);
    expect(await bidBook.isValuationEligible(0, addr, COLLECTION_TRAIT)).to.equal(false);
    await bidBook.connect(bidder).updateBid(1, usdc(140), 10);
    expect(await bidBook.isValuationEligible(1, addr, traitKey("Hat", "Crown"))).to.equal(true);
  });

  it("rejects bids on traits held by fewer than five tokens", async () => {
    const { bidBook, nft, registry, bidder } = await loadFixture(deployCore);
    const addr = await nft.getAddress();
    await registry.setTraitCounts(addr, [traitKey("Hat", "Halo")], [4]);
    await expect(bidBook.connect(bidder).placeBid(addr, traitKey("Hat", "Halo"), usdc(10), 1)).to.be.revertedWith(
      "trait too rare",
    );
  });

  it("only machines can earmark", async () => {
    const { bidBook, bidder } = await loadFixture(deployCore);
    await expect(bidBook.connect(bidder).earmark(0, COLLECTION_TRAIT, 1, 0)).to.be.revertedWith("not a machine");
  });
});

describe("FloorBook", () => {
  it("moves the curve on each trade and pays the maker the spread", async () => {
    const { floorBook, quote, nft, seller, maker, player } = await loadFixture(deployCore);
    const addr = await nft.getAddress();
    await quote.connect(maker).approve(await floorBook.getAddress(), ethers.MaxUint256);
    await floorBook.connect(maker).createOrder(addr, usdc(100), 500, 500, usdc(1000), []);

    // bid = 100 / 1.05 * 0.95
    const bid = await floorBook.bidPrice(0);
    expect(bid).to.equal((((usdc(100) * 10000n) / 10500n) * 9500n) / 10000n);

    await nft.connect(seller).approve(await floorBook.getAddress(), 0);
    await floorBook.connect(seller).sellToOrder(0, 0, 0);
    expect((await floorBook.orders(0)).spotPrice).to.equal((usdc(100) * 10000n) / 10500n);

    await quote.connect(player).approve(await floorBook.getAddress(), ethers.MaxUint256);
    const spot = (await floorBook.orders(0)).spotPrice;
    await floorBook.connect(player).buyFromOrder(0, usdc(1000));
    expect(await nft.ownerOf(0)).to.equal(player.address);
    const o = await floorBook.orders(0);
    expect(o.cash).to.equal(usdc(1000) - bid + spot);
    expect(o.cash).to.be.gt(usdc(1000)); // round trip earned the spread
  });
});

describe("Machine", () => {
  it("rejects invalid tier configurations", async () => {
    const { factory, nft } = await loadFixture(deployCore);
    const base = {
      nft: await nft.getAddress(), spinPrice: usdc(50), targetRtpBps: 8900, creatorFeeBps: 250, riskBps: 2500,
      pityThreshold: 40, tiers: TIERS, name: "x",
    };
    await expect(factory.createMachine({ ...base, targetRtpBps: 9800 })).to.be.revertedWith("rtp");
    await expect(factory.createMachine({ ...base, pityThreshold: 5 })).to.be.revertedWith("pity");
    const wide = [...TIERS];
    wide[1] = { ...wide[1], maxValue: usdc(100) };
    await expect(factory.createMachine({ ...base, tiers: wide })).to.be.revertedWith("band too wide");
    const probs = TIERS.map((t, i) => (i === 0 ? { ...t, baseProbBps: 1 } : t));
    await expect(factory.createMachine({ ...base, tiers: probs })).to.be.revertedWith("probs");
  });

  it("locks the expected value of the next spin at the target", async () => {
    const { machine } = await loadFixture(deployMachineWithInventory);
    const o = await machine.previewOdds();
    expect(o.open).to.equal(true);
    let ev = 0n;
    let total = 0n;
    for (let k = 0; k < 5; k++) {
      ev += o.probs[k] * o.evs[k];
      total += o.probs[k];
    }
    expect(total).to.be.closeTo(10n ** 18n, 10n);
    expect(ev / 10n ** 18n).to.be.closeTo(usdc(44.5), 2n);
  });

  it("settles a spin: player gets the NFT, seller gets V + premium, bidder gets the pricing fee", async () => {
    // Seller take = V * (1 + 2% premium - 0.5% pricing fee); no royalty on a first sale.
    const { machine, randomness, quote, nft, player, seller, bidder, treasury, bidBook } =
      await loadFixture(deployMachineWithInventory);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    const sellerBefore = await quote.balanceOf(seller.address);
    const bidderBefore = await quote.balanceOf(bidder.address);

    await machine.connect(player).spin(ethers.ZeroAddress);
    expect(await machine.pendingSpins()).to.equal(1n);
    const tx = await randomness.fulfillWith(1, 123456789n);
    const receipt = await tx.wait();
    const settled = receipt!.logs
      .map((l) => { try { return machine.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "SpinSettled");
    expect(settled, "SpinSettled").to.not.equal(undefined);
    const { tokenId, value, earmarkId } = settled!.args;

    expect(await nft.ownerOf(tokenId)).to.equal(player.address);
    expect((await quote.balanceOf(seller.address)) - sellerBefore).to.equal((value * 10150n) / 10000n);
    expect((await quote.balanceOf(bidder.address)) - bidderBefore).to.equal((value * 50n) / 10000n);
    // protocol 1.5% + frontend 1% (no frontend -> treasury)
    expect(await quote.balanceOf(treasury.address)).to.equal(usdc(1.25));

    // The winner can sell the NFT to the earmarked bid for V within the exit window.
    const playerBefore = await quote.balanceOf(player.address);
    await nft.connect(player).approve(await bidBook.getAddress(), tokenId);
    await bidBook.connect(player).fillEarmark(earmarkId);
    expect(await nft.ownerOf(tokenId)).to.equal(bidder.address);
    expect((await quote.balanceOf(player.address)) - playerBefore).to.equal((value * 9900n) / 10000n);
  });

  it("refunds when randomness never arrives", async () => {
    const { machine, quote, player } = await loadFixture(deployMachineWithInventory);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    const before = await quote.balanceOf(player.address);
    await machine.connect(player).spin(ethers.ZeroAddress);
    await expect(machine.cancelExpiredSpin(1)).to.be.revertedWith("not expired");
    await time.increase(DAY + 1);
    await machine.cancelExpiredSpin(1);
    expect(await quote.balanceOf(player.address)).to.equal(before);
  });

  it("drops a listing whose bid was withdrawn and redraws instead of paying a stale value", async () => {
    const { machine, randomness, quote, bidBook, bidder, player } = await loadFixture(deployMachineWithInventory);
    // Cancel the floor bid: floor listings now have no backing.
    await bidBook.connect(bidder).cancelBid(0);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    const settledTiers: bigint[] = [];
    for (let i = 1; i <= 10 && (await machine.previewOdds()).open; i++) {
      await machine.connect(player).spin(ethers.ZeroAddress);
      const receipt = await (await randomness.fulfillWith(i, BigInt(i) * 7919n)).wait();
      for (const log of receipt!.logs) {
        const e = (() => { try { return machine.interface.parseLog(log); } catch { return null; } })();
        if (e?.name === "SpinSettled") settledTiers.push(e.args.tier);
      }
    }
    // Floor listings are never paid out at the stale value: they are dropped when drawn.
    expect(settledTiers).to.not.include(0n);
    // Once the floor tier is empty the cheapest live tier is above the target, so the machine closes.
    expect(await machine.tierListings(0)).to.have.length(0);
    expect((await machine.previewOdds()).open).to.equal(false);
  });

  it("blocks valuation changes while spins are pending", async () => {
    const { machine, quote, player } = await loadFixture(deployMachineWithInventory);
    await quote.connect(player).approve(await machine.getAddress(), ethers.MaxUint256);
    await machine.connect(player).spin(ethers.ZeroAddress);
    await expect(machine.refreshValuation(0, 0)).to.be.revertedWith("spins pending");
  });

  it("queues LP withdrawals for a day", async () => {
    const { machine, lp } = await loadFixture(deployMachineWithInventory);
    const shares = await machine.sharesOf(lp.address);
    await machine.connect(lp).requestWithdraw(shares);
    await expect(machine.connect(lp).claimWithdraw()).to.be.revertedWith("locked");
    await time.increase(DAY + 1);
    await machine.connect(lp).claimWithdraw();
    expect(await machine.totalShares()).to.equal(0n);
  });
});

describe("OddsMarket", () => {
  async function oddsFixture() {
    const core = await deployCore();
    const { odds, quote, nft, lp, seller, player } = core;
    await quote.connect(lp).approve(await odds.getAddress(), ethers.MaxUint256);
    await odds.connect(lp).deposit(usdc(100_000));
    await nft.connect(seller).approve(await odds.getAddress(), 5);
    await odds.connect(seller).list(await nft.getAddress(), 5, usdc(2000));
    await quote.connect(player).approve(await odds.getAddress(), ethers.MaxUint256);
    return core;
  }

  it("charges q x ask plus fees and pays the seller ask + bonus on a win", async () => {
    const { odds, randomness, quote, nft, seller, player } = await loadFixture(oddsFixture);
    const [stake, total] = await odds.quoteOdds(0, 1000);
    expect(stake).to.equal(usdc(200));
    expect(total).to.equal(usdc(212));
    const sellerBefore = await quote.balanceOf(seller.address);
    await odds.connect(player).buyOdds(0, 1000, ethers.ZeroAddress);
    await randomness.fulfillWith(1, 999n); // 999 % 10000 < 1000 -> win
    expect(await nft.ownerOf(5)).to.equal(player.address);
    expect((await quote.balanceOf(seller.address)) - sellerBefore).to.equal(usdc(2030));
  });

  it("keeps the stake in the vault on a loss and the listing stays open", async () => {
    const { odds, randomness, nft } = await loadFixture(oddsFixture);
    const assetsBefore = await odds.totalAssets();
    const [, player] = (await ethers.getSigners()).slice(3);
    await odds.connect(player).buyOdds(0, 1000, ethers.ZeroAddress);
    await randomness.fulfillWith(1, 5000n); // lose
    expect(await nft.ownerOf(5)).to.equal(await odds.getAddress());
    expect((await odds.listings(0)).active).to.equal(true);
    expect((await odds.totalAssets()) - assetsBefore).to.equal(usdc(207)); // stake + vault fee
  });

  it("refuses asks larger than the vault can carry", async () => {
    const { odds, nft, seller, player } = await loadFixture(oddsFixture);
    await nft.connect(seller).approve(await odds.getAddress(), 6);
    await odds.connect(seller).list(await nft.getAddress(), 6, usdc(50_000));
    await expect(odds.connect(player).buyOdds(1, 1000, ethers.ZeroAddress)).to.be.revertedWith("vault too small");
  });
});
