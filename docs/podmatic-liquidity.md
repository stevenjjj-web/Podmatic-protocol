# Learning from Tensor: Market Making for NFTs, Funded by Gacha Flow

> This document studies Tensor's NFT liquidity design, distills what Podmatic should borrow and what it must avoid, and proposes mechanisms where every party earns from new money.
> Pricing architecture: [`podmatic-pricing.md`](podmatic-pricing.md). New simulation: [`sim/mm_sim.py`](../sim/mm_sim.py), results in [`sim/mm_results.md`](../sim/mm_results.md).
> Tensor product details come from its official docs (read 2026-10-25); market data comes from third-party reporting, listed under Sources.

---

## 0. Summary

**What Tensor got right**: it turned NFT trading from "list one item at a time and wait for a buyer" into automated orders:

- collection bids, listings and two-sided market-making orders all carry a price curve and reprice after every fill;
- one balance can back many bids at once (shared escrow);
- makers set their own spread, makers pay no platform fee, and takers pay 2%.

It also ran two experiments directly relevant to us:
- **YOLO Buy**: pay part of the price for a chance to win one specific listed NFT;
- **Price Lock**: 7-day locked-price trades on NFTs.

**What Tensor did not solve**:
1. Its automated market making only works for floor items. The official docs explicitly warn makers **"never deposit a rare NFT"** into a market-making order: someone will buy the rare item at the order's price and you get a common one back.
2. A maker's income depends on volume, and most NFT volume comes from informed traders and points farmers.

**What we can add**: gacha brings **uninformed flow** that ignores outside prices and pays for entertainment. In simulation, the same market-making order over 90 days:

| Gacha flow | Paths underperforming holding |
|---|---|
| None | 50% |
| 1 floor NFT bought from the order by spins per day | 14% |
| 3 per day | 5% |
| 6 per day | 1% |

**Five mechanisms**, in priority order:

1. **Open the floor layer to every market-making order**: spin and sell-back flow routes to the best quotes instead of relying on the protocol vault alone.
2. **Trait bids on shared escrow, earmarked only when drawn**: the same capital covers far more traits, so more rare items can be priced.
3. **Odds buys (inspired by YOLO Buy)**: any listed NFT, including rare items no bid can price, can be bought as a probability, with the vault carrying the variance. Faster and more flexible than ticket raffles.
4. **Market-making income only from real flow, no points**: Blur and Tensor both showed that liquidity bought with points leaves when the incentives end.
5. **Bring collection teams in as participants**: teams can fund floor and trait bids and sponsor collection machines in exchange for new buyers and royalties.

---

## 1. How Tensor works and what it innovated

### 1.1 Three automated order types + price curves

Tensor's AMM (TensorSwap) has three order types, all with configurable price curves:

| Order | What it does | What the curve does |
|---|---|---|
| Collection bid | Buys any NFT in the collection at a price, possibly several | Lowers the bid after each purchase |
| Listing order | Lists several NFTs at once | Raises the price after each sale |
| Two-sided market-making order | Holds SOL and NFTs, buys and sells | Both sides move the price; the maker earns the spread |

Two curve types (examples from the official docs):

- **Linear**: a fixed SOL step. A bid starting at 1 SOL with a 0.1 SOL step fills at 1, 0.9, 0.8, 0.7, 0.6 SOL.
- **Exponential**: a percentage step. A listing starting at 1 SOL with a 10% step fills at 1, 1.1, 1.21, 1.331, 1.4641 SOL.

A market-making order sells at the current price and buys at "current price minus one step, less the spread fee". Makers set the spread fee themselves, from 0 to 25%; the docs suggest about 5%. The suggested starting setup is a start price near the global floor, a step of about 5% and a spread fee of about 5%.

**In essence**: Uniswap has one protocol-wide curve; Tensor lets each maker bring their own curve and spread, which amounts to an order book made of many small AMMs.

### 1.2 Fees: makers free, takers pay

- Makers (including market-making orders) pay 0% platform fee and no royalties;
- Takers pay a 2% platform fee and enforced royalties; for optional royalties, the taker chooses to pay all, half or none.

Providing liquidity costs nothing, which encourages market making.

### 1.3 Shared escrow

One SOL balance can back many bids at once, including collection, trait and single-item bids:

- every bid whose price fits within the balance is active at the same time;
- when the balance is used up and can no longer cover a bid, that bid deactivates and the rest stay live;
- each bid can carry a purchase cap so one bid cannot drain the balance.

**In essence**: all bids rarely fill at once, so they do not need to be fully funded individually. It is the same idea as fractional reserve banking.

### 1.4 Trait bids and collection bids

You can bid on the whole collection or only on NFTs with a given trait. For the first time, trait premiums had an executable buy-side quote. Our pricing architecture is built on exactly this.

### 1.5 Price Lock: locked-price NFT trades

Fixed 7-day terms; users choose only the price, not the term or fee; fees start at about 3.8%. Users can go long or short. The team went through 10–20 UX iterations before settling on the design.

**Takeaway**: NFT users will accept derivatives, but only with extremely simple rules.

### 1.6 YOLO Buy: probabilistic purchases

- Bid on one specific listing for a fraction of its price; a higher bid means higher odds, from 1% to 75%;
- uses verifiable randomness (VRF) with commit-reveal, verifiable on chain;
- bids are non-refundable; losers still earn points;
- every listing under 500 SOL is eligible;
- sellers earn an extra 1.5% when sold through YOLO Buy;
- not available in every region.

**Takeaway**: this is already the seed of a "single-item draw". The buyer sees the specific NFT and decides how much probability to buy. The seller gets the full price plus a bonus, so sellers participate.

### 1.7 Incentives and token

- Listing orders near the floor in the top 100 by 24-hour volume earn points; closer to the floor earns more;
- TNSR launched in April 2024 with a 1 billion supply and a 125 million (12.5%) airdrop;
- reportedly, in late 2025 the Tensor Foundation acquired the Tensor marketplace and platform fees now go to the TNSR treasury.

### 1.8 Limits

| Limit | Evidence |
|---|---|
| Automated market making only fits floor items | Official: never deposit a rare NFT into a market-making order |
| Maker returns depend heavily on volume | The docs' APY example: an order earned about 6.1% in 2 days, about 1,100% annualized, but only "if it keeps trading at the same rate"; a one-way market empties the order, and when trading stops so does income |
| Impermanent loss | The docs' example: when the floor falls from 4 to 1, the maker ends with 4 NFTs worth 4, while simply holding would be worth 7 |
| Points-driven liquidity is unstable | Blur's bid pool once lost over $16 million in one day, about a fifth of buy-side liquidity, mostly from one points farmer that made up about 40% of the market |

---

## 2. What to borrow and what not to copy

| Tensor's approach | Podmatic's choice |
|---|---|
| Each maker brings a curve and spread | **Borrow**: open the floor layer to every market-making order; the protocol vault is just one maker (section 4.1) |
| Shared escrow | **Borrow, with a change**: trait bids value drawn NFTs, so funds must be earmarked when an NFT is drawn, or the valuation could vanish (section 4.2) |
| Purchase caps | **Borrow**: every trait bid has a cap |
| Makers free, takers pay | **Borrow**: consignment and market-making orders are free; spins and direct buys pay |
| YOLO Buy | **Borrow and extend**: odds buys backed by the vault and tied into the machine ecosystem (section 4.3) |
| Price Lock | **Not yet**: get spins and odds buys right first, derivatives later |
| Points incentives | **Do not copy**: market-making income only from real flow (section 4.4) |
| Floor only | **Fill the gap**: trait bids and odds buys cover everything above the floor |

---

## 3. The core judgement: NFTs lack uninformed buyers, not matching

Tensor has taken matching very far, yet NFT liquidity is still poor. Three reasons:

1. **There are almost no uninformed buyers.** Most NFT buyers know what they are doing, and a slightly stale quote gets picked off.
2. **Rare items have no buyer at any given moment.** Floor items trade daily; rare items can go months without interest.
3. **Incentives are subsidies.** When points and airdrops end, liquidity leaves.

Gacha supplies exactly the first: **players pay for randomness and entertainment, not for a specific price**. That is new money the NFT market never had, and it can pay market makers, appraisers and sellers.

**Simulation** (`sim/mm_sim.py`): a Tensor-style two-sided market-making order starting with 10 floors of cash and 10 floor NFTs, a 3% step and a 4% spread fee. The floor moves 4% per day and arbitrageurs pay 2% outside. 90 days, 300 paths:

| Floor NFTs bought from the order by spins per day | Excess return vs holding (median) | P10 | Paths underperforming holding |
|---|---|---|---|
| 0 | −0.2% | −22.6% | 50% |
| 1 | +17.1% | −5.0% | 14% |
| 3 | +47.0% | +10.4% | 5% |
| 6 | +103.8% | +63.8% | 1% |

How to read it:

- **Without gacha flow, market making is a directional bet**: half the paths trail holding and the worst tenth lose over 20%. That is why NFT market making never scaled.
- **With gacha flow, market making becomes a spread business.**
- The returns are high because the maker's capital is small relative to the flow. As more makers arrive, spreads compress and returns fall. That is the outcome we want: competition lowers what machines pay for floor items, and the savings flow back into returns.
- The model ignores sell-back timing, floor jumps and competition between orders; the numbers only show direction.

---

## 4. Five mechanisms

### 4.1 Open the floor layer to every market-making order

The previous floor pool was a single protocol-maintained curve. Now **anyone can place a Tensor-style market-making order** (their own start price, step and spread), and the protocol aggregates them into a floor order book.

- When a machine needs a floor NFT, it buys from the order with the lowest ask;
- when a player wins a floor NFT and sells it back, it goes to the order with the highest bid;
- holders' floor consignments sit in the same book, queued by floor price;
- the protocol vault is just one maker.

**Benefits**:
- makers compete on spread, so machines pay less for inventory;
- risk is spread over many makers instead of one vault;
- makers can reuse their Tensor strategies and experience.

**Valuation is unchanged**: a floor item is still valued at the best executable bid. The spread a machine pays is a machine cost and is included in the return lock.

### 4.2 Trait bids: shared escrow + earmark on draw

In the pricing architecture, a rare item enters blind draws only if a trait bid covers it. Simulation shows only 1.8% of rare items are covered early on; the bottleneck is the shortage of trait bids.

Borrowing Tensor's shared escrow:

1. An appraiser-maker deposits one balance and places many trait bids, each with a price and a purchase cap.
2. When an NFT is drawn, the bid that valued it **earmarks** the value from the balance for 72 hours, so the winner can always sell into it.
3. If unused after 72 hours, the earmark is released automatically.
4. **A bid can value NFTs only if the balance covers "already earmarked + this bid's price"**; otherwise the valuation falls back to the next bid or the floor.

**Capital efficiency**: a balance only needs to cover earmarks inside the 72-hour window. If a collection draws 10 NFTs a day priced by one maker, averaging 3 floors each, the maker needs at most about 10 × 3 × 3 = 90 floors earmarked to keep bids on hundreds or thousands of traits. The real requirement also depends on how often winners sell back.

**Income**: appraiser-makers earn twice:
- a 0.5% pricing fee on the value of each drawn NFT;
- when winners sell back, they buy the NFT at their own bid. As long as the bid is below true value, that is cheap inventory.

### 4.3 Odds buys: every NFT can be drawn

In the pricing architecture, rare items that cannot be priced go through single-item raffles that draw only when tickets sell out. Waiting for a sell-out is the problem: unpopular items may never sell out.

Borrowing YOLO Buy, we switch to **odds buys**:

- any listed NFT (with the seller's ask A) can be bought as a probability;
- the buyer pays q × A × (1 + fee) for probability q of winning, with q between 1% and 50%;
- VRF decides. On a win, the vault buys the NFT at A for the buyer; on a loss, the money stays in the vault;
- the seller receives A plus a 1.5% bonus whenever the NFT is won;
- the vault's expected profit is the fee share and it carries the variance, so A may not exceed "risk factor × vault reserve", reusing v2's water-level rule.

**Why the seller's ask A is safe here**: blind draws cannot use seller quotes because players do not choose a specific NFT, so overpricing costs the seller nothing. In an odds buy, the buyer sees exactly which NFT and at what price, and simply does not buy if it is too expensive. An overpriced ask just attracts no buyers. The logic matches single-item raffles, but nobody waits for a sell-out: anyone can buy any amount of probability at any time.

**For holders of rare items**: before, they might wait months for one buyer willing to pay in full; now 100 people each buying 1% have the same effect. **Odds buys widen a rare item's buyers from "one wealthy collector" to "a crowd willing to take a small bet".**

### 4.4 Market-making income only from real flow

No points, no token subsidies. Every income stream traces back to what players pay:

| Income | Source |
|---|---|
| Floor makers' spread | Uninformed flow from machines and sell-backs |
| Appraiser-makers' pricing fees | Part of the seller settlement premium |
| Vault house edge | Blind-draw return and odds-buy fees |
| Seller bonuses | Part of odds-buy fees; blind-draw settlement premium |

If a token ever launches, it only distributes protocol fees that already exist and never buys liquidity. Blur's lesson: bids bought with points leave together when the points end, and they invite wash trading.

### 4.5 Bring collection teams in as participants

NFT teams care most about their floor and about new buyers. Podmatic gives teams three ways in:

- **Floor and trait bids**: the team treasury backstops the floor with bids and becomes an appraiser-maker earning pricing fees.
- **Sponsored collection machines**: the team runs an official draw machine and earns the creator fee. Some players will own an NFT from the collection for the first time.
- **Royalties**: odds buys and machine sales are real sales and pay royalties as usual.

---

## 5. Where the new money comes from and where it goes

**New money** has two sources, neither of which existed in the NFT market before:
- the entertainment cost spinning players pay, about 10% of the spin price;
- odds-buy fees.

| Role | Before | New income | Source |
|---|---|---|---|
| Floor holders | List and wait, or sell at a discount to collection bids | Steady buying from machines | Gacha flow |
| Rare holders | Wait months for one buyer | Odds buys turn buyers into a crowd; 1.5% extra on a sale | Odds buys |
| Floor makers | Mostly trade against informed traders and trail holding half the time | Steady spread from uninformed flow | Gacha flow |
| Appraiser-makers | Role did not exist | Pricing fees + cheap inventory from sell-backs | Settlement premium |
| Vault LPs | — | Blind-draw house edge + odds-buy fees | Players' entertainment cost |
| Creators and collection teams | Teams only earned royalties | Share of machine flow; new holders | Gacha flow |
| Players | Could not afford a whole NFT, or could only trade near the floor | Join for a few to a few dozen dollars; redeemable returns | Pay the entertainment cost |
| Protocol | — | 1.5% per trade | Gacha flow |

**Be clear about who pays**: players. The expected loss of a blind draw is about 10% of the spin price, and the expected loss of an odds buy equals its fee. In return they get entertainment, a shot at an outsized win and a redeemable return. This is the system's only outside source of money, so the web app must show it clearly.

---

## 6. Risks and open questions

1. **The NFT market itself is shrinking.** Our new money comes from gacha players, which assumes we can bring existing on-chain gacha users (the $230–325M of monthly spend cited in v1) to NFTs. That needs validation.
2. **Regulation.** Tensor's YOLO Buy is itself not available everywhere. Odds buys and blind draws face the same gambling classification question.
3. **Cost of aggregating market-making orders.** A spin has to scan several market-making orders for the best price within one transaction's gas budget. This may need off-chain sorting with on-chain verification.
4. **Earmark limits.** How far shared escrow can be levered and how long the earmark window should be need calibration against real draw and sell-back data.
5. **Vault risk on odds buys.** Is a 50% cap on win probability right? What share of the reserve should cap a single NFT's ask?
6. **Relationship with Tensor.** Can Tensor's makers and trait bids plug in directly, for example by reading Tensor bid accounts as a valuation source? That depends on whether their programs allow cross-program calls. If so, we would not need to build a bid market from scratch.

---

## Sources

- Tensor docs: [bonding curves](https://docs.tensor.trade/provide-liquidity/advanced-concepts/bonding-curves.md), [market-making orders](https://docs.tensor.trade/trade/get-started-with-tensors-amm/market-make.md), [shared escrow](https://docs.tensor.trade/trade/shared-escrow.md), [fees and royalties](https://docs.tensor.trade/trade/fees-and-royalties.md), [YOLO Buy](https://docs.tensor.trade/trade/yolo-buy.md), [impermanent loss](https://docs.tensor.trade/provide-liquidity/advanced-concepts/impermanent-loss.md), [expected APY](https://docs.tensor.trade/provide-liquidity/what-apy-can-you-expect.md), [risks](https://docs.tensor.trade/provide-liquidity/what-are-the-risks.md), [why provide liquidity](https://docs.tensor.trade/provide-liquidity/why-provide-liquidity.md)
- Price Lock and history: [Alea Research, Tensor: Past, Present and Future (2024-02-06)](https://alearesearch.substack.com/p/tensor-past-present-and-future)
- TNSR launch: [The Block](https://www.theblock.co/post/287028/tensor-foundation-launches-governance-token-tnsr); reporting on the foundation acquiring the marketplace: [OneKey blog](https://onekey.so/blog/ecosystem/tnsr-deep-dive-tokenomics-recent-developments-and-outlook) (relaying PANews and SolanaFloor; no official Tensor source found)
- Blur bid pool withdrawals: [The Defiant](https://thedefiant.io/news/nfts-and-web3/ethereum-nfts-crater-as-blur-incentives-wind-down)
