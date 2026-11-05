# Podmatic Pricing Architecture

> This is the pricing layer of the v2 design ([`podmatic-v2-design.md`](podmatic-v2-design.md)). It replaces v2's "seller ask capped by an oracle" and the previous revision of this document ("model pools").
>
> Simulations:
> - [`sim/premium_sim.py`](../sim/premium_sim.py): four ways of pricing collection NFTs, results in [`sim/premium_results.md`](../sim/premium_results.md)
> - [`sim/pricing_sim.py`](../sim/pricing_sim.py): price curve vs oracle-capped asks for interchangeable assets, results in [`sim/pricing_results.md`](../sim/pricing_results.md)

---

## 0. Summary

### What the previous revision got wrong

The previous revision assumed that items of the same "model" are interchangeable. That only holds for homogeneous assets like graded cards. In a PFP collection such as SMB, every NFT is unique and prices differ by several times to tens of times depending on traits. There is no "model" to price together. The previous price curve only works for the interchangeable part.

### The revised architecture

An NFT's value is split into three parts, each priced differently:

| Part of value | Example | Interchangeable? | Pricing method |
|---|---|---|---|
| **Floor** | Any SMB is worth at least the floor | Yes | **Floor pool**: price moves with pool inventory and is pinned to the outside floor by arbitrage |
| **Trait premium** | The premium shared by all SMBs with a given rare trait | Partly: many NFTs share a trait | **Committed bids**: someone locks funds in a contract and commits to buy any NFT with that trait at a price |
| **Individual premium** | A unique trait combination, a 1/1 | No | **Not in blind draws**: a transparent single-item raffle priced by a descending (Dutch) auction, so buyers who can see the NFT set the price |

Three principles:

1. **Only redeemable prices count as value**: either a market curve or a bid backed by locked funds. Not seller quotes, not appraisal models.
2. **Sellers give a floor, never a quote**: the pool or the bid sets the price; the floor only decides whether to sell.
3. **Blind draws only contain what can be reliably priced**: rare items that cannot be priced go to transparent single-item raffles.

In one line:

> **Uniswap turns the funds LPs lock into a price. Podmatic turns the bids buyers lock into a valuation.**

### Simulation results

Four pricing methods compared on a trait-priced collection. Rarity classes: near floor 70%, mid 22%, rare 6%, ultra rare 2%.

| Method | Player gets / displayed value | Seller take / true value | Problem |
|---|---|---|---|
| A. Oracle cap (common practice) | **77.6%** (ultra rare only 61.7%) | 128.8% | Sellers list exactly the NFTs the model overvalues; players pay for it |
| B. Floor only | 107.4% | 93.1% | Nothing above near-floor lists; no rare prizes in machines |
| C. Seller self-guarantee: winner may return at 90% of the ask | about 86–90% | about 113% | 73% of winners return the NFT; even a 30% return penalty leaves about half returned |
| **D. Committed-bid valuation** | **100.0%** | **99.4–99.9%** | Few rare items list; single-item raffles fill the gap, and it improves as the bid market matures |

C is a design we came up with ourselves and the simulation rejected; section 6 explains why.

---

## 1. Why collection NFTs are hard to price

1. **Every item is different.** Floor items and rare-trait items in one collection can differ by tens of times; no single price represents them all.
2. **Trades are sparse.** Floor items trade daily; a rare item may trade once in months, so its last sale is stale.
3. **Sellers quote high.** Sellers know their NFT and have every reason to ask a lot.
4. **Appraisal models are least accurate on rare items.** Trait models (rarity ranks, regressions on past sales) are decent near the floor and get worse as rarity rises, and rare items are exactly a draw machine's top prizes.
5. **Buying only at the floor keeps rare items out.** Collection bids and floor pools only pay floor; holders of rare items will not sell at floor.

Draw machines make all of this worse: **spin demand does not pick a specific NFT**, so no buyer's choice disciplines any single NFT's price. Whenever the protocol overvalues an NFT, sellers list it and players eat the loss. That is why method A leaves players with only 77.6% of the displayed value.

---

## 2. Architecture overview

```
                    ┌───────────────────────────────────────────────────┐
  Asset adapters    │ identify collection, read traits (on-chain        │
                    │ snapshot), classify the asset                     │
                    └───────────────────────────────────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
  ┌──────────────┐                ┌──────────────┐                 ┌──────────────┐
  │ Floor pool   │                │ Bid book     │                 │ Single-item  │
  │ interchange- │                │ trait        │                 │ raffle       │
  │ able part    │                │ premium      │                 │ individual   │
  │ curve +      │                │ collection / │                 │ premium      │
  │ arbitrage    │                │ trait bids   │                 │ Dutch auction│
  └──────────────┘                └──────────────┘                 └──────────────┘
        │                                │                                │
        └───────────────┬────────────────┘                                │
                        ▼                                                 │
      Value V = max(floor pool bid, best eligible trait bid covering it)  │
                        │                                                 │
                        ▼                                                 ▼
              ┌──────────────────────┐                        ┌──────────────────────┐
  Inventory   │ Floor orders: drawable│                       │ Raffle: draws when   │
              │ when V >= floor       │                       │ tickets sell out     │
              └──────────────────────┘                        └──────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
  Machines    │ Blind draws: return  │
              │ locked on V          │
              └──────────────────────┘
```

---

## 3. Modules

### 3.1 Floor pool: the interchangeable part of a collection

> Later revision: the floor layer is opened to any Tensor-style market-making order; the protocol vault is just one maker. See [`podmatic-liquidity.md`](podmatic-liquidity.md) section 4.1.

**What counts as a floor item**: an NFT that no trait bid covers, only the collection floor bid. To the market these NFTs are worth floor and are interchangeable.

Each collection has a floor pool. It reuses the previous price curve, with the "model" replaced by the collection floor:

| Event | Price change |
|---|---|
| An NFT is sold into the pool | P ← P × (1 − 2%) |
| An NFT leaves the pool (drawn or bought) | P ← P × (1 + 2%) |
| The pool is empty | P ← P × (1 + 1%) per day |
| Inventory above target | P ← P × (1 − 0.5%) per day |

Bid = P × (1 − 2%), ask = P × (1 + 2%). Collection floors trade actively on Tensor and Magic Eden, so arbitrageurs push the pool back to the outside floor: if the pool is expensive they buy floor items outside and sell them in; if it is cheap they buy from the pool and sell outside.

`sim/pricing_sim.py` validates the curve: with an oracle that lags 7 days and errs by about 10%, the curve's median valuation error is 3.5% versus 9.1% for oracle-capped asks. A graded card "model" is simply a floor pool for a homogeneous asset, so the same code applies.

**Any NFT can be sold at floor**: a holder of a rare item who needs cash can sell at the floor pool bid. That is the liquidity floor for the whole collection.

### 3.2 Bid book: trait premiums priced by locked funds

> Later revision: trait bids can use a shared escrow, with funds earmarked only when an NFT is drawn, to widen trait coverage. See [`podmatic-liquidity.md`](podmatic-liquidity.md) section 4.2.

Anyone can place a bid in the contract and lock funds behind it:

| Bid type | Covers | Can it value NFTs? |
|---|---|---|
| Collection bid | Any NFT in the collection | Yes, as the floor reference |
| Trait bid | Any NFT with a given trait, e.g. "wears a crown" | Yes |
| Trait-combination bid | Any NFT with several traits | Yes, if at least 5 NFTs in the collection match |
| Single-item bid | One specific NFT | **No**, it can only trade |

**Why single-item bids cannot value NFTs**: a seller could open a second wallet, bid high on their own NFT and inflate its valuation. A trait bid is different: any holder of that trait can sell into it at that price. Inflating a valuation means buying every NFT with that trait at the inflated price, which is expensive.

**An eligible bid**:
- has rested at least 24 hours;
- values NFTs at its lowest price over the last 3 days, so it cannot be pumped briefly;
- is fully funded in the contract, so any matching holder can sell into it directly.

**Who places trait bids**:

- **Collectors** who already want a trait at some price.
- **The vault**, as a market-making strategy, putting the NFTs it buys back into machines.
- **Appraiser-makers**, a new role. When their bid sets the value of an NFT that gets drawn, they earn 0.5% of the value as a **pricing fee**. Accurate appraisals pay; overpricing means buying at that price. **Appraisal goes from a free, unaccountable service to a business backed by capital that earns money.**

### 3.3 Valuation formula

```
V = max(floor pool bid, best eligible trait bid covering this NFT)
```

- **The return is measured in V.** A winner can always sell the NFT to the bid that defines V, so every displayed value is redeemable.
- **Consignors settle at V × (1 + u)**, with u = 3% by default. 0.5% of it is the pricing fee to the appraiser-maker and 2.5% goes to the seller. That is the reason to consign into a machine instead of selling straight to the bid.
- A drawn NFT uses up one fill of the bid that defines its V, so one bid cannot value many NFTs at once.

### 3.4 Floor orders: sellers only say "not below"

As in the previous revision, holders only give a floor F. An NFT becomes drawable only when V × (1 + u) ≥ F. When trait bids rise, the NFT enters range automatically; when bids are pulled, it leaves. Reporting the true floor is the seller's best strategy, because the bid sets the price and the floor only decides whether to sell.

### 3.5 Single-item raffles: transparent auctions for rare items that cannot be priced

> Later revision: inspired by Tensor's YOLO Buy, "odds buys" become the main path for rare items. Buyers pay a share of the ask for the same chance to win, the vault carries the variance, and nobody waits for tickets to sell out. See [`podmatic-liquidity.md`](podmatic-liquidity.md) section 4.3.

Rare items and 1/1s that no trait bid covers up to the seller's floor **do not go into blind draws**. They get a transparent single-item raffle:

1. The page shows everything about this one NFT, so buyers know what they are buying into.
2. The seller sets a starting total and a reserve; the total drops every hour (Dutch auction).
3. When the first ticket is bought, the total locks; ticket count = total ÷ ticket price, and the remaining tickets sell at that price.
4. The raffle draws when tickets sell out; if they do not sell by the deadline, all tickets are refunded and the NFT returns to the seller.
5. If the price reaches the reserve with no buyer, the auction ends.

The first buyer willing to pay sets the price; a high starting price does not help the seller. Unlike blind draws, raffle buyers are **informed**: they see exactly which NFT it is, so their pricing is reliable.

### 3.6 Collection machines

For a PFP collection with floor price F:

| Tier | Contents | Value |
|---|---|---|
| Floor tier | NFTs in the floor pool | about 1 F |
| Trait tier | NFTs covered by trait bids with V of 1.3–3 F | 1.3–3 F |
| Rare-trait tier | NFTs covered by trait bids with V above 3 F | above 3 F |

- **Floor-denominated pricing**: the spin price is a multiple of the floor (e.g. 1.6 F), converted to USDC at the floor pool TWAP on each spin. When the whole collection moves, the machine's economics do not change.
- **Minimum spin price**: every prize is worth at least one floor, so at an 89% return the spin price must exceed the floor. For example 75% floor tier, 20% averaging 2 F and 5% averaging 5 F gives an expected value of about 1.4 F and a spin price of about 1.6 F.
- **Low entry**: for collections with a high floor, v1's group spins split the cost.
- **Odds**: v2's return lock; the contract solves the odds every spin from each tier's in-range inventory and V.

---

## 4. Uniswap comparison (revised)

| Uniswap | Podmatic |
|---|---|
| ERC-20 makes tokens interchangeable | Only the floor part is interchangeable: collection floor pools, graded card model pools |
| Price = a function of pool inventory | Floor price = a function of floor pool inventory |
| LPs lock funds to provide liquidity and earn fees | Appraiser-makers lock funds in trait bids and earn pricing fees |
| Arbitrageurs push the pool back to the outside price | Arbitrageurs push the floor pool back to the outside floor; holders sell straight into overpriced trait bids |
| Concentrated liquidity (v3) | Floor orders: drawable only when the value is in range |
| Noise traders pay LPs | Spinning players pay market makers |

---

## 5. Simulation results in detail

`sim/premium_sim.py`, 200,000 candidate holders. Full tables in `sim/premium_results.md`.

**A. Oracle cap.** Sellers list only when the model values their NFT above their reservation price. Every NFT the model overvalues comes in; every one it undervalues stays out. Players get only 77.6% of the displayed value (ultra rare: 61.7%) and sellers receive 128.8% of true value. **The rarer the item, the worse it gets.**

**B. Floor only.** Only 5.5% of near-floor holders sell, and nothing above near floor lists. Prices are safe, but machines have no top prizes.

**C. Seller self-guarantee** (section 6). 73% of winners return the NFT.

**D. Committed-bid valuation**:

| Rarity | Listing rate: early → mature bid market | Seller take / true value: early → mature | Player gets / displayed value |
|---|---|---|---|
| Near floor | 34.1% → 34.1% | 100.9% → 100.9% | 100.0% |
| Mid | 7.4% → 18.1% | 93.6% → 97.1% | 100.0–101.1% |
| Rare | 1.8% → 8.6% | 88.9% → 93.8% | 100.0–100.3% |
| Ultra rare | 0.1% → 2.0% | 85.3% → 90.9% | 100.0% |

"Early" assumes trait bids cover 90% / 70% / 40% of mid, rare and ultra-rare NFTs at 80–95% / 70–90% / 55–85% of true value. "Mature" assumes coverage of 97% / 90% / 70% at 88–98% / 82–95% / 70–92%.

How to read it:

1. **Players always get the displayed value**, because the valuation is itself an executable bid.
2. **Rare listing rates depend on the depth of the bid market.** More bids, closer to true value, let more rare items into machines. Pricing fees exist to grow that market.
3. **Early on, rare items mostly go through single-item raffles.** That is not a flaw but an honest outcome: a price nobody will back with money should not be a blind-draw valuation.

Model limits: reservation prices, bid levels and liquidity discounts are assumed distributions; bids and arbitrage do not evolve over time; trait-bid coverage needs calibration against real collections.

---

## 6. Why not "seller self-guarantee"

This was our first idea: sellers quote their own price; a winner who thinks it is too high may return the NFT within 72 hours for 90% of the ask; a return voids the sale and the seller pays a penalty. "Whoever sets the price is accountable" sounds right.

The simulation rejected it:

| Return penalty | Return rate | Listing rate | Player gets / displayed value |
|---|---|---|---|
| 3% | 66–73% | 59–76% | 79–86% |
| 10% | 56–63% | 24–42% | 81–88% |
| 20% | 48–55% | 11–23% | 84–90% |
| 30% | 43–50% | 6–14% | 85–91% |

Three reasons:

1. **Sellers treat returns as a free option.** With a low penalty, overpricing is a cheap bet: if kept, the seller wins; if returned, they lose only the penalty.
2. **Returns are random.** Sellers and winners both misjudge value, so honest quotes get returned a lot too.
3. **Rare items get returned for liquidity.** Rare NFTs are hard to sell, so winners prefer 90% in cash, and honestly priced rare items come back as well.

A higher penalty reduces overpricing, but return rates stay above 40% while listing rates collapse. The problem is not the parameters; it is letting sellers price their own NFTs. Value has to come from someone other than the seller who is willing to put money behind it.

---

## 7. Changes from earlier revisions

| Item | v2 | Previous revision (model pools) | This revision |
|---|---|---|---|
| Asset assumption | Physical cards with a known reference price | Items of one model are interchangeable | Every collection NFT is different; only the floor part is interchangeable |
| Source of value | External oracle | Model pool curve | Floor pool curve + trait bids |
| What sellers give | An ask | A floor | A floor |
| Seller settlement | The ask | Model pool TWAP | V × (1 + 3%) |
| Rare items | Mixed into machines at oracle value | Not addressed | Blind draws only when a bid covers them; otherwise single-item raffles |
| New role | — | — | Appraiser-makers earning pricing fees |
| Player sell-back | Fixed 88% | Model pool bid | Sell to the bid that defines the value, or into the floor pool |

---

## 8. On-chain implementation

**Accounts**

| Account | Contents |
|---|---|
| CollectionRegistry | Collection, verified creator address, Merkle root of the trait snapshot |
| TraitProof | Trait proof for an NFT (against the snapshot root), submitted on first listing |
| FloorPool | Collection floor pool: price P, TWAP accumulator, inventory, price ticks |
| Bid | Type (collection / trait / trait combination / single item), trait condition, price, remaining fills, locked funds, creation time, 3-day minimum price record |
| BidIndex | Best eligible bid per trait, for fast valuation |
| FloorOrder | Floor order: NFT, floor, owner, the bid currently used for its value |
| SingleRaffle | Single-item raffle: NFT, starting total, reserve, decay rate, locked price, tickets sold, deadline |

**Traits must be snapshotted on chain.** Many collections have mutable metadata, so reading current metadata would let traits change. The protocol snapshots all traits when a collection is registered, stores the Merkle root, and listings submit proofs.

**Instructions**

- `register_collection`, `snapshot_traits`: register a collection and write its trait snapshot.
- `place_bid`, `cancel_bid`, `fill_bid`: place a bid, cancel it, sell an NFT into it.
- `place_floor`, `cancel_floor`: place or cancel a floor order.
- `refresh_valuation`: anyone may call; recomputes an NFT's value and range status from current eligible bids.
- `sell_to_floor_pool`, `buy_from_floor_pool`: floor pool trades.
- `create_single_raffle`, `buy_tickets`, `settle_single_raffle`, `refund_single_raffle`: single-item raffles.
- `fulfill_spin`: locks the return on in-range NFTs and V per tier; on a win, settles V × (1 + u) to the seller, pays the pricing fee and uses up a fill of the bid.

---

## 9. Open questions

1. **Initial trait-bid depth**: who bids early? How much capital should the vault commit to trait bids? Is a 0.5% pricing fee enough to attract professional makers?
2. **Minimum coverage for trait-combination bids**: is 5 matching NFTs enough to stop self-appraisal? Should it scale with collection size?
3. **Counting outside bids**: Tensor and others already host trait bids. Can they be read on chain and used for valuation? That depends on whether their programs allow cross-program fills.
4. **Minimum spin price**: every prize is worth at least the floor, so collection machines cost more than the floor per spin. For high-floor collections, are group spins and single-item raffles enough to lower the entry?
5. **Who pays the pricing fee**: it currently comes out of the settlement premium u. Should it come from protocol fees instead, so sellers keep more?
6. **Legal status of single-item raffles**: they are closer to lotteries and need their own legal opinion.
