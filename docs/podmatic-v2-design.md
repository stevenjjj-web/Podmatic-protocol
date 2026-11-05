# Podmatic v2: A Market-Making Protocol for Collectibles

> This document builds on v1, "Card Pool Protocol: Uniswap for Gacha Pools" (2026-10-23), and deepens the product design, economic model and narrative.
> All simulated numbers come from [`sim/podmatic_sim.py`](../sim/podmatic_sim.py); full output in [`sim/results.md`](../sim/results.md).
> Market data reuses v1's sources and was not re-verified here.
>
> **Implementation notes** (`contracts/contracts/Machine.sol`): inventory yield, circulation royalty and pity are implemented, with these differences from this document:
> - Inventory yield does not use the APR curve. Instead, a fixed 1.5% of each spin is split across tiers by their contribution to expected value and within a tier by listing value. Thinly stocked tiers pay more per listing, which has the same effect as the curve without time-based accrual or keepers.
> - The circulation royalty is 1% of value, paid from the seller's settlement premium; first consignors are tracked per machine; LPs pay nothing.
> - Anyone can pre-fund the pity pool (`fundPity`). With this document's parameters a pity spin costs about $225 extra while each spin adds only $0.50, so new machines need the creator to pre-fund the pool for pity to be honoured early.
> - The seller settlement premium is lowered from 3% to 2% to fund inventory yield and pity.
>
> **The pricing layer has been updated**: this document's "seller ask capped by an oracle" has been replaced by the pricing architecture in [`podmatic-pricing.md`](podmatic-pricing.md) (floor pool + trait bids + single-item raffles). For listing rules (section 3.7), player costs (section 4.5) and LP returns (section 2), that document takes precedence. The seller numbers here assume an oracle without error; with a noisy oracle, the v2 approach lowers players' real return by about 7 percentage points.

---

## 0. Summary

v1's simulation reached one key conclusion: **capital is not the bottleneck; prize supply and traffic are**. v2 therefore moves the design's centre of gravity from machines to holders: protocol profit should flow first to the scarcest party, holders willing to put their cards in.

| Question | v2's answer |
|---|---|
| How do we attract holders? | Listing is not consignment; it is market making. Holders have four exits: consign and make markets, sell instantly to the vault, deposit the card for LP shares, or a whole-card raffle. While consigned, cards earn yield based on how scarce their tier is, and after a sale they earn a circulation royalty each time the card is drawn again. In the base machine, consigned cards sell in a median of about 4 days for about 100.7% of reference value. Today's platforms buy back at 85–90% of market. |
| Can every party make money? | Yes. Every $100 of spins has a clear destination (section 2). Across 9 simulated scenarios with 30 paths each, there were zero insolvencies, the player return stayed locked at target, and sellers, creators, frontends and the protocol all earned positive income. LPs take the residual: positive at the median, but with losing paths when the reserve is small relative to prizes (section 2.3), and compressed as machines compete on return. |
| How are odds and spin prices set? | Spin prices use standard denominations ($25 / $50 / $100 / $250 / $1,000) and tiers are defined as multiples of the spin price. Creators only choose the odds shape and a target return; the contract solves the actual odds for each spin from live inventory so the expected value equals the target. v2 ships three presets: Steady, Standard and Chase. |
| Prices span a huge range: should creators get more power? | Yes, within limits. Creators can narrow each tier's price band within the protocol's standard multiples, set admission rules and choose a machine type, but cannot widen bands, touch funds or change settlement prices. The range is handled in three layers: a ladder of denominations splits the market, each tier spans at most 3x, and cards above a machine's cap (60x the spin price) go to whole-card raffles. |
| Is this sound, and will people come? | The economics work. Holders get clearly better terms than their current options, so supply is the easiest side to bootstrap. The real uncertainty lies outside the mechanism: whether custodians allow their NFTs into third-party programs, how each jurisdiction regulates draws, and whether creators bring traffic. Section 7 lists validation steps and kill criteria. |

**The four most important changes from v1**

1. **Inventory yield curve**: listed consignments earn yield based on how scarce their tier is; the scarcer the tier, the higher the yield.
2. **Return lock**: creators set the odds shape and target return, and the contract solves the actual odds every spin, replacing v1's fixed odds plus range check.
3. **Tiers by reference value**: the return is also measured in reference value (the player's view), while sellers are still paid their ask (the seller's view); the two are no longer mixed.
4. **Cold start moves from zero capital to a minimum seed reserve**: simulation shows that machines with no or too little seed lock up permanently after an early big prize, so v2 requires "a seed reserve of 100x the spin price + a 0.1 risk factor" and adds a shared bootstrap vault (section 6).

---

## 1. A new narrative: from "Uniswap for gacha pools" to "a market-making protocol for collectibles"

### 1.1 Why change the narrative

v1's narrative centred on machines: anyone can open one. That works for creators, but gives the scarcest party, holders with cards, no compelling reason to show up.

What Uniswap really changed was not "anyone can create a pair" but **turning idle tokens in wallets into market-making capital that earns fees**. v2 applies the same logic to collectibles:

> **Uniswap turned idle tokens into market-making capital. Podmatic turns idle collectibles into market-making inventory.**
> **Spinning is trading. Listing is market making.**

### 1.2 Comparison table (v2 revision)

| Uniswap | Podmatic | Notes |
|---|---|---|
| Trading pair | USDC ↔ a set of collectibles | Each machine is a pool |
| A trade | A spin | A fixed-price trade with a random asset |
| LP | Card LPs (consignors) + cash LPs (vault) | Two kinds of makers: one supplies inventory, the other the reserve |
| Fees | Distribution of the house edge | To sellers, creators, frontends, the protocol and LPs |
| v3 price ranges | Tier price bands | A card provides liquidity only in the tier its price falls in |
| Fee tiers (0.05 / 0.3 / 1%) | Standard denominations ($25–$1,000) | Common denominations let inventory and credits move between machines |
| Router | Listing router + credit router | Cards find the best machine; credits work across machines |
| Impermanent loss | Price risk while listed | Asks can lag the market when the oracle lags; limited by a "take the lower" rule |

### 1.3 One line for each party

- **Holders**: your card starts earning even in the vault. Sell close to market, earn while you wait, and keep earning after the sale.
- **Players**: every spin's odds, return and inventory are on chain, and every card can be sold back at 88%.
- **Creators**: no inventory, no upfront capital. Open your own machine and earn a share of flow.
- **The industry**: the buyback spreads and pack margins of the incumbents become public, competitive parameters here.

### 1.4 What is disruptive

Incumbents' moat is their own inventory plus margins they set themselves: buybacks typically 10–15% below market and undisclosed pack expected values (v1, page 2). Podmatic holds no inventory, so it can hand that margin to card holders. **Our competitors' margin is our budget for paying supply.** To follow, incumbents would have to give up their most profitable business.

---

## 2. Money waterfall: who earns what

### 2.1 Where $100 of spins goes (standard machine, default parameters)

| Destination | Amount | To | Notes |
|---|---|---|---|
| Expected prize value | 89.0 | Consignors (or vault-recycled cards) | Draw return in reference value, locked by the contract |
| Pity pool | 1.0 | Players | Triggers after 40 spins without Rare or better; players' effective return is about 90% |
| Inventory yield pool | 2.0 | Listed consignors | Paid along the yield curve; the reserve tops up shortfalls, capped at 6% of the day's flow; leftovers return to the reserve |
| Creator | 2.5 | Creator | Protocol cap 3% |
| Frontend | 1.0 | Frontend operator | Protocol cap 1% |
| Protocol | 1.5 | Protocol treasury | The protocol's only income |
| Residual | about 3.0 | Vault LPs | Plus recycling spread, minus circulation royalty and yield top-ups |

LP income is a residual, not a fixed share. It has three sources: the roughly 3% residual per spin; recycled cards, sold back by players at 88% or traded in at 95%, which cost the reserve nothing when drawn again; and the gap when asks are below reference value. It has two costs: yield top-ups and the circulation royalty.

### 2.2 Actual income in simulation (base machine: 400 spins/day, $600k monthly flow, $20k LP)

Exact numbers are in part 2 of `sim/results.md`. The structural conclusions:

| Role | Income | Scale |
|---|---|---|
| Players | Expect about 89% of the spin price back in reference value (excluding pity); any card can be sold back at 88% within 72 hours | Expected loss about 10–11% of the spin price |
| Consignors | The ask (about 99% of reference) + inventory yield (about 1.4%) + circulation royalty when the card is drawn again | About 100–101% of reference, with royalties afterwards |
| Creator | 2.5% of flow | $15k per month at $600k monthly flow |
| Frontend | 1% of flow | $6,000 per month |
| Protocol | 1.5% of flow | $9,000 per month |
| Vault LPs | Residual, about 6–9% of flow | Extremely high early returns that competition will compress; losing paths when the reserve is small |

### 2.3 Why high LP returns are not a problem

Early LP returns are absurdly high: NAV grows several times in 90 days, as in v1's simulation. The reason is that a machine needs very little capital: $20k supports a machine with $3,000 legendary cards and $600k of monthly flow. This is an early windfall, and two forces will push it down:

1. **LP capital floods in and dilutes returns.** Creators can cap a reserve, but new machines are permissionless, so capital moves to other machines.
2. **Machines compete for players on return.** When the return rises from 89% to 93%, the LP share of flow falls from 8.3% to 4.0% (the "Competitive" scenario), and the difference goes to players.

LPs do not win every time. The simulation has two kinds of losing paths: the worst path of a machine at a 93% return loses 47% of NAV; the worst path of a small machine with a $10k reserve and $3,000 top prizes loses 67%. The cause is the same: with thin margins or a reserve small relative to prizes, a cluster of legendary hits causes a deep drawdown. So the frontend must show LPs "reserve ÷ top prize" and the historical maximum drawdown, and the protocol should never market LP shares as fixed income.

This is exactly what Uniswap-style competition does: profit moves from the abundant party (capital) to the scarce ones (traffic and supply). The protocol is designed so this happens automatically, not by operator decision.

---

## 3. Holders: from "consign and wait for a buyer" to "listing is market making"

This section answers the core question: how to get holders who want to sell NFTs to plug in, and earn ongoing income and a good sale price.

### 3.1 Where holders stand today

- Collector Crypt has tokenized over 130,000 graded cards (v1, page 12). A holder who wants quick cash basically has to accept the platform's buyback at 85–90% of market.
- Listing on a secondary market like Magic Eden means poor liquidity and uncertain timing.
- A card sitting in the vault earns nothing and carries price risk.

So holders want only three things: **sell high, sell fast, earn while waiting**. v1 only solved the first.

### 3.2 Four exits

When a holder brings a custodied card to Podmatic, they choose one of four exits:

| Exit | What they get | When | Who it suits |
|---|---|---|---|
| **① Consign and make markets** (default) | The ask, up to 105% of reference; inventory yield while waiting; circulation royalty after the sale | Paid instantly when drawn; yield accrues daily | Those who want a high price and can wait a few days |
| **② Instant sale to the vault** | 90% of reference in USDC on the spot | Immediately | Those who need cash now; still as good as or better than platform buybacks at 85–90% |
| **③ Card-to-LP** | Vault LP shares worth 85% of reference, 30-day lock | Shares issued immediately, ongoing income | Those who do not need cash and believe in the machine's flow; this is the real "ongoing income" |
| **④ Whole-card raffle** | Ticket sales minus a 6% fee; ticket count = ask ÷ 94% ÷ ticket price, rounded up | Paid when tickets sell out and the raffle draws; full refund if not sold out by the deadline | Cards above any machine's cap, such as a $50k grail |

Exit ② opens only when the vault has ample cash and that tier's inventory is below target. The vault effectively keeps a standing bid: buy at 90%, relist at reference and earn about 10% gross.

Exit ③ issues shares at the same mark used for vault NAV (recycled cards at 85% of reference), so it does not dilute existing LPs. When the card is drawn it realizes about 100% of its value, and the difference is shared by all LPs, including the depositor.

Exit ④ needs no reserve: a card with a reference value and ask of $2,500 opens 54 tickets at $50, $2,700 in total; when they sell out, the seller gets 94%, or $2,538, about 101.5% of reference (the extra comes from rounding up the ticket count); players' return is 2,500 ÷ 2,700 ≈ 92.6%. If not sold out, every ticket is refunded. It is the only way for a card worth tens of thousands of dollars to be won by players paying tens of dollars while the seller gets full price.

### 3.3 Inventory yield curve

**Idea**: listed cards give players "something to win", which is itself liquidity, so they should be paid like Uniswap LPs. But the money should go where inventory is missing, not be split evenly.

**Definition**: for each tier k of each machine,

```
Days of coverage D_k = total reference value of listed consignments in the tier ÷ expected daily payout of the tier
APR_k                = 8% + (100% − 8%) × clamp((30 − D_k) / (30 − 3), 0, 1)
```

- With 3 days of coverage or less the APR is 100%; with 30 days or more it is 8%.
- Each card earns `reference value × APR_k / 365` per day. Using reference value instead of the ask means raising your ask earns no extra yield.
- Funding: first the 2% per-spin yield pool, then the reserve tops up, with total daily spend capped at 6% of the day's flow and scaled down beyond that. Leftovers in the pool return to the reserve.

**Why this design**

- **Self-balancing**: whichever tier is short pays the most, so holders fill it themselves; when inventory is abundant, yield falls automatically. No operator tuning.
- **Bounded cost**: daily spend equals `APR × days of coverage / 365 × the day's payout`. Within the 3–30 day range this peaks at about 16 days of coverage, around 2.4% of payout; in heavy oversupply the hard cap of 6% of daily flow applies. In the base simulation, actual spend was under 1% of flow.
- **Easy to understand**: the frontend shows "this tier currently pays X% APR, expected sale in Y days".

**Anti-gaming rules**

| Abuse | Rule |
|---|---|
| List and delist repeatedly to farm yield | Yield is claimable only after a listing has rested 72 hours; delisting within 7 days forfeits unclaimed yield to the pool |
| Overstate value to earn more | Yield is computed on reference value; the ask cap is `105% × min(7-day average, latest three-source median)` |
| Manipulate reference prices | Reference values are per card model, three-source median, take the lower; models with too few sales cannot list |
| One wallet monopolizes a tier | Creators can cap listings per wallet per tier |
| List your own card and spin for it | Each spin costs about 7% in fees, far more than the yield; self-dealing does not pay |

### 3.4 Circulation royalty: keep earning after the sale

After winning, about 60% of players sell back or trade in (v1's simulation assumption). Those cards go to the vault and are relisted; when drawn again, the reserve pays nobody. That is LPs' second income source.

v2 carves out a small share of it for **the card's original consignor**:

> Each time a recycled card is drawn again, 2% of its reference value goes to whoever first consigned it.

At a 60% recycling rate a card is drawn again `0.6 ÷ 0.4 = 1.5` times on average; in the simulation's 90-day window recycled cards were 53% of draws, about 1.1 times. So consignors earn about 2–3% more, spread over the following weeks and months. The cost comes out of LPs' recycling spread, about 0.94% of flow in simulation. This makes holders prefer machines with high flow and high recycling, and gives "ongoing income" a real source instead of token subsidies.

### 3.5 Running the numbers

**A Rare card with a $110 reference value** (base machine)

| Choice | Proceeds | Time |
|---|---|---|
| Platform buyback | $93.5–99 (85–90%) | Immediate |
| Secondary market listing | Uncertain, minus marketplace fees | Uncertain, possibly weeks |
| ① Consign at a fair ask | about $109 ask + about $1.5 yield + about $2–3 circulation royalty later ≈ $113 (about 103%) | Median about 4 days, P90 about 14 days |
| ① Consign at 95% to sell faster | about $104.5 + yield and royalty | 1.17x the in-tier draw weight of a fair ask |
| ② Instant sale to the vault | $99 (90%) | Immediate |

**A Legendary card with a $2,500 reference value**

| Choice | Proceeds | Time |
|---|---|---|
| Platform buyback | $2,125–2,250 | Immediate |
| ① Consign to a machine with $600k monthly flow | about $2,475 + yield + royalty | Median about 4–5 days |
| ① Consign to a small machine with $150k monthly flow | Same | Median about 9 days, P90 about 37 days |
| ④ Whole-card raffle, 54 tickets at $50 | $2,538 | Depends on how fast tickets sell; full refund if not sold out |

Conclusion: **for any holder who can wait a few days, listing on Podmatic earns about 12–20% more than a platform buyback** (consignment nets about 101% of reference, plus later royalties, versus 85–90% buybacks). The gap is large enough for supply to bootstrap without subsidies.

### 3.6 Seller dashboard and listing router

- **Dashboard**: each card shows its tier, expected days to sale, current APR, accrued yield and royalties received, plus a repricing simulator: "lower your ask by X% to raise your draw chance by Y%". Holders are notified the moment a card is drawn.
- **Listing router**: after connecting a wallet, the router reads every eligible card and recommends the best machine and ask for each (ranked by expected days to sale and APR), with one-click listing for all. It is the supply-side equivalent of the Uniswap router.
- **Card shops and large holders (B2B)**: a bulk listing API. Physical card shops can send stock to a partner custodian and turn shop inventory into yield-bearing listings.

### 3.7 Revised listing rules

> This section has been replaced by the new pricing architecture: sellers no longer set asks; they place floor orders, and value comes from the floor pool and trait bids. See [`podmatic-pricing.md`](podmatic-pricing.md) section 3.

| Rule | v1 | v2 | Reason |
|---|---|---|---|
| Tier assignment | Ask | **Reference value** | A tier label describes what the player gets and should not be manipulable by the ask |
| Return measured in | Ask | **Reference value (player's view)**, settlement at the ask | The number players see is the market value they get |
| Ask cap | 105% of reference | **105% × min(7-day average, latest median)** | The 7-day average lags in falling markets; taking the lower stops sellers dumping overvalued cards on players |
| In-tier weight | (V/a)^4 | **(V/a)^3, clamped to 0.5–2x** | Answers v1's open question: a 10% discount raises draw odds by about 37%, avoiding destructive undercutting; the clamp keeps displayed odds stable |
| Pause condition | Reference falls below 1/1.15 of the ask | Unchanged | — |

---

## 4. Odds and spin price design

### 4.1 Standard denominations

A machine's spin price must be one of five values: **$25 / $50 / $100 / $250 / $1,000**.

Why not let creators pick anything:

- **Shared inventory**: the same card lands in the same tier in every machine of a denomination, so the listing router can compare machines.
- **Shared credits**: trade-in credits and upgrade paths are denominated per tier and can settle across machines (section 5.5).
- **Player understanding**: "a $50 machine" and "a $250 machine" mean the same everywhere, like Uniswap's fee tiers.

Micro machines under $10 come later and only for ungraded or purely digital asset adapters, because custody and grading costs keep graded cards above roughly $10–15 each.

### 4.2 Tiers defined as multiples of the spin price

| Tier | Value band (× spin price) | $25 machine | $50 machine | $100 machine | $250 machine | $1,000 machine |
|---|---|---|---|---|---|---|
| Common | 0.2–0.6 | 5–15 | 10–30 | 20–60 | 50–150 | 200–600 |
| Uncommon | 0.6–1.5 | 15–37.5 | 30–75 | 60–150 | 150–375 | 600–1,500 |
| Rare | 1.5–4 | 37.5–100 | 75–200 | 150–400 | 375–1,000 | 1,500–4,000 |
| Epic | 4–12 | 100–300 | 200–600 | 400–1,200 | 1,000–3,000 | 4,000–12,000 |
| Legendary | 12–60 | 300–1,500 | 600–3,000 | 1,200–6,000 | 3,000–15,000 | 12,000–60,000 |
| Above 60x | — | Whole-card raffle | | | | |

Three hard rules:

1. **The smallest prize is at least 20% of the spin price.** The protocol does not allow "junk cards" to fill the Common tier.
2. **Each tier spans at most 3x (Legendary at most 5x).** Otherwise "Rare" loses meaning: if one tier holds both $75 and $400 cards, the displayed odds no longer describe what a player gets.
3. **A machine's top prize is at most 60x the spin price.** Bigger cards need too much reserve and take too long to unlock; they belong in higher-denomination machines or whole-card raffles.

All five cards of v1's example machine ($15, $40, $110, $450, $2,500) fit the standard tiers of a $50 machine.

### 4.3 Return lock: creators set the shape, the contract solves the odds

In v1, creators set fixed odds and the contract only checked that the return fell within 85–97%. The problem: the cards listed in each tier keep changing, so each tier's average value drifts and the actual return drifts with it.

v2's approach:

1. The creator sets an **odds shape** (base probability π_k per tier) and a **target return** T between 85% and 97%.
2. On every spin, the contract computes each tier's expected value ā_k from currently drawable cards (weighted reference value).
3. The contract tilts the odds toward the highest or lowest drawable tier so the expected value equals T exactly:

```
E = Σ π_k · ā_k
If E < T: π' = (1−t)·π + t·δ_highest drawable, t = (T − E) / (ā_highest − E)
If E > T: π' = (1−t)·π + t·δ_lowest drawable,  t = (E − T) / (E − ā_lowest)
```

4. **Open conditions**: at least two tiers have drawable cards, the lowest drawable tier's expected value is at or below T, and the highest is at least 85% of the spin price.
5. If the water level cannot reach T, this spin's return drops to the highest reachable value (not below 85%), and the frontend shows "current return X%, reserve too low" in real time. If the conditions fail, the machine pauses new spins.

Three benefits: the return players see is accurate on every spin; creators need no probability math, only a shape; and inventory changes cannot quietly make a machine stingier.

### 4.4 Three presets ($50 machine, 89% draw return)

| Preset | Common | Uncommon | Rare | Epic | Legendary | Hit rate (≥1x) | ≥5x | ≥20x | Spin std dev |
|---|---|---|---|---|---|---|---|---|---|
| Steady | 68.86% | 21.41% | 7.30% | 2.14% | 0.29% | 19.2% | 2.00% | 0.20% | 2.10x |
| Standard | 71.98% | 18.04% | 7.02% | 2.71% | 0.25% | 18.0% | 2.41% | 0.17% | 2.06x |
| Chase | 80.38% | 11.95% | 4.98% | 1.99% | 0.70% | 13.0% | 2.28% | 0.48% | 2.91x |

- **Steady**: more mid-tier prizes, roughly 1 in 5 spins breaks even; suits new players and continuous livestream opening.
- **Standard**: close to v1's example machine.
- **Chase**: nearly 3x the legendary odds at the cost of more commons; suits machines built around one grail.

All three presets have the same expected value and differ only in variance. Creators define a machine's personality through its shape, but cannot change players' expected loss with it.

### 4.5 The real cost to players (must be shown clearly in the frontend)

> Under the new pricing architecture, players can sell a won NFT to the bid that defines its value or into the floor pool; there is no fixed 88% buyback. At the floor pool bid (about 96%), the cost of selling back immediately falls from about 21% to about 15% per spin. See [`podmatic-pricing.md`](podmatic-pricing.md) section 3.3.

| Player behaviour | Value kept per spin | Real cost per spin |
|---|---|---|
| Keep the win | about 90% (89% + about 1% pity) | about 10% |
| Sell back immediately at 88% | about 79% | about 21% |
| Trade in at 95% and spin again, repeatedly | about 85.5% | about 14.5% |

These numbers are not flattering, but they must be public: this is the disclosure gambling regulators care most about, and the clearest difference between us and platforms that hide their expected values.

### 4.6 Pity

v1 triggered pity after 30 spins without Rare or better, paid from a pity pool funded by 1% of flow. Simulation shows the cost is very sensitive to the threshold (Standard preset, cost as a share of the spin price):

| Threshold | 20-spin session | 50 spins | 200 spins |
|---|---|---|---|
| 20 | 0.00% | 3.63% | 4.64% |
| 30 | 0.00% | 0.90% | 1.43% |
| 40 | 0.00% | 0.21% | 0.46% |
| 50 | 0.00% | 0.00% | 0.15% |

**v2 changes the default threshold to 40.** A 1% pool then has a surplus at any session length, which can fund seasonal events. A threshold of 30 overspends in long sessions. The protocol rule: when the pity pool holds less than 30 days of expected payouts, the threshold rises by 10 automatically.

### 4.7 Default parameters (v2)

| Parameter | Default | Creator range | Set by |
|---|---|---|---|
| Spin price | $50 | 25 / 50 / 100 / 250 / 1,000 | Creator |
| Draw return (reference value) | 89% | 85–97% | Creator |
| Odds shape | Standard | Three presets or custom | Creator |
| Number of tiers | 5 | 3–5, non-overlapping | Creator |
| Price band per tier | Standard multiples | Can narrow, not widen | Creator |
| In-tier weight | (V/a)^3, clamped to 0.5–2x | — | Protocol |
| Ask cap | 105% × min(7-day average, latest median) | — | Protocol |
| Cash buyback | 88%, 72 hours | 80–95%, 24–168 hours | Creator |
| Trade-in | 95% | 90–98% | Creator |
| Pity | 1% funding, threshold 40 | Threshold 30–60 | Creator, auto-raised by protocol |
| Inventory yield | 2% per spin; 8–100% APR; capped at 6% of flow | — | Protocol |
| Circulation royalty | 2% of reference | 0–3% | Creator |
| Risk factor | 0.25 with LPs; 0.1 with only a seed reserve | — | Protocol |
| Minimum reserve | 100x the spin price | Can come from the shared bootstrap vault | Protocol |
| Sell-back buffer | Below 20 spins of reserve, cash sell-back becomes trade-in | — | Protocol |
| Fees | Protocol 1.5% / creator 2.5% / frontend 1% | Creator ≤3%, frontend ≤1% | Protocol caps |

---

## 5. Price range and creator powers

### 5.1 Why the price range is a problem

Tokenized cards range from $10 to $500,000. Putting cards that differ too much into one machine causes three problems:

1. **Not enough reserve**: the pricier the legendary cards, the more reserve is needed and the slower they unlock, so players wait a long time for the grail.
2. **Diluted odds**: to fit a $50,000 card into a $50 machine at an 89% return, its odds have to be a few in a hundred thousand, which looks like a scam.
3. **Misleading labels**: if the Rare tier holds both $75 and $1,500 cards, "7% chance of Rare" says nothing about what a player will get.

### 5.2 Three layers

| Layer | What it does | Owner |
|---|---|---|
| Denomination ladder | Five denominations from $25 to $1,000 split the market; each machine covers at most 0.2–60x its spin price | Protocol |
| Narrower tiers | Creators narrow each tier's band within the standard multiples for a tighter theme | Creator |
| Whole-card raffles | Cards above 60x the spin price stay out of machines and get their own raffle | Seller |

### 5.3 Conclusion: curation powers for creators, with limits

**Creators should be able to restrict price bands.** It is their most important curation tool and defines a machine's theme and player experience. But the powers must meet two conditions: they can only be stricter than the protocol standard, never looser; and they never touch funds or settlement.

| Power | Protocol hard limit | Creator | Seller | Player |
|---|---|---|---|---|
| Spin price | Standard denominations only | Chooses denomination | — | — |
| Price bands | Standard multiples; each tier ≤3x (Legendary ≤5x); top ≤60x | Narrows within the range | — | — |
| Admission | Registered custody adapters only | Custodian, category, set, year, grader and grade, language | — | — |
| Odds | Return 85–97%; contract solves actual odds | Shape + target return | Influences in-tier weight via the ask | — |
| Ask | Capped at 105% of reference (take the lower) | Cannot change | Sets it | — |
| Listing review | Open machines cannot review | Curated machines can whitelist or review each listing | — | — |
| Per-wallet cap | — | Listing cap per wallet per tier | — | — |
| Featured cards | — | Can boost a chosen card's yield from their own fee | — | — |
| Buyback parameters | 80–95%, 24–168 hours | Sets within the range | — | Chooses to sell back, trade in or keep |
| Parameter changes | 24-hour notice; pending spins unaffected | Proposes changes | Can delist during the notice | Can see them during the notice |
| Funds and NFTs | Nobody can touch them | Cannot touch | Can withdraw only their own cards not in a pending spin | — |

### 5.4 Three machine types

| Type | Who can list | Suits | Extra rules |
|---|---|---|---|
| **Open** | Anyone meeting the admission rules | Broad themes, e.g. "Pokémon PSA 10" | No review power |
| **Curated** | Creator review or whitelist | Distinct themes, e.g. "first editions only", "one artist's work" | Creator's own listings are flagged "creator-owned", at most 50% per tier |
| **Creator-stocked** | Creator only | KOLs or card shops opening with their own collection | Clearly labelled in the frontend; still bound by the return lock and public odds |

### 5.5 Series and upgrade spins

A **series** is a group of machines by one creator at different denominations, e.g. "XX's Pokémon" at $50, $250 and $1,000. Within a series:

- Credits are shared: credit earned in the $50 machine can be spent in the $250 machine.
- Upgrade spins: trade a card in at 95% for credit and spin a higher-denomination machine directly.
- Reserves are separate: each machine has its own reserve and LPs; when credit is spent, the issuing machine settles USDC to the spending machine.

Later, credit settlement extends from series to the whole protocol as a "credit router": credit from any machine can be spent at any machine of the same or higher denomination.

### 5.6 Preventing creator abuse

| Abuse | Defence |
|---|---|
| Stuffing the machine with their own overpriced cards | Ask cap takes the lower; creator-owned flag; at most 50% creator-owned per tier in curated machines |
| Quietly lowering the return | Return lock plus 24-hour notice; the frontend shows historical actual returns |
| Using review power to exclude others | Only curated machines can review; open and curated machines are listed separately |
| Running off | Creators never hold funds or NFTs; when a machine pauses, withdrawals, buybacks and delisting still work |

---

## 6. Cold start revised: from "zero capital" to "minimum seed + shared bootstrap vault"

### 6.1 The problem simulation found

v1 assumed zero-capital machines could grow through water-level unlocking. v2's simulation found a fatal flaw:

> If a machine with a tiny reserve hits an Epic or Legendary early, its reserve is emptied. Only Common and some Uncommon cards remain drawable, the expected value falls below the return floor, and the machine has to pause. While paused, no new flow comes in, so the reserve never recovers: **the machine deadlocks**.

The root cause is the risk factor. v1 set the risk factor to 1.0 without LPs, so one card's ask could equal the entire reserve and a single win could empty it. Simulation results ($50 machine, 100 spins/day, 30 paths):

| Seed reserve | Risk factor | Demand served (median) | Notes |
|---|---|---|---|
| $500 (10x spin) | 1.0 | about 1% | Almost always deadlocks |
| $2,000 (40x) | 1.0 | about 10% | Bimodal: some paths grow normally, more deadlock early |
| $5,000 (100x) | 0.1 | 100% | No deadlock; after 90 days the lowest seed NAV across 30 paths is $27.5k, median about $40k. The cost: early on, legendary cards wait for the reserve to grow, with a median of about 22 days to sale for legendary consignments |

A risk factor of 0.1 means no single card's ask exceeds 10% of the reserve. One big prize uses at most a tenth of the reserve, so a single spin can never empty it; high tiers unlock as the reserve grows, which is exactly v1's "the water level is the marketing" intent.

### 6.2 Revisions

1. **Minimum reserve of 100x the spin price with a 0.1 risk factor**: $5,000 for a $50 machine. Creators can fund it themselves or apply to the shared bootstrap vault. Once outside LPs join, the risk factor returns to 0.25.
2. **Shared bootstrap vault**: a protocol-level USDC vault that backs many new machines with a fixed allocation each (e.g. 100x the spin price) in exchange for LP shares in them. The benefit is diversification: a single machine is highly variable, but a hundred together are smooth. Bootstrap vault LPs earn the return of a portfolio of new machines.
3. **Sell-back buffer**: below 20 spins of reserve, cash sell-backs automatically become trade-ins, preventing early sell-back runs on the reserve.
4. **The water level counts cash only**: credit can only buy spins and cannot be withdrawn, so it is not deducted when computing the water level; every prize payment must still be covered by cash.

### 6.3 Cold-start sequence (revised)

| Stage | v1 | v2 |
|---|---|---|
| 0 | 5 zero-capital creator machines | 5 creator machines, each seeded with 100x the spin price by the team or the bootstrap vault; **at the same time**, recruit the first sellers and onboard them through the listing router |
| 1 | Vault LPs open | Bootstrap vault opens to the public; card-to-LP launches |
| 2 | Expand assets and chains | Whole-card raffles, Courtyard adapter, series and upgrade spins |
| 3 | Self-custody seals | Unchanged |

At stage 0 the team needs about $25k of seed reserve (5 machines at $50, $5,000 each). This revises v1's "team holds no inventory and no reserve", but the amount is small, and the money is itself LP shares that earn.

---

## 7. Is this design sound? Will people come?

### 7.1 Simulation conclusions

The simulation covers 9 scenarios: base, three cold starts, small machine, large machine, thin supply, bear market (prices −25% over 90 days) and competitive (93% return), with 30 paths of 90 days each.

| Check | Result |
|---|---|
| Insolvencies | Zero in every scenario |
| Player return | Locked near target (random variation comes from legendary hits) |
| Consignor proceeds | Median about 100–102% of reference (including yield), median 3–5 days to sale |
| Bear market | LP NAV stays positive; price risk falls mainly on consignors (who must lower asks), LPs only bear the markdown of recycled cards |
| Thin supply | Machines pause for lack of stock about a third of the time; the yield curve hits its maximum APR, a clear signal |
| Competitive | At a 93% return, median LPs still profit, with the LP share of flow falling from 8.3% to 4.0%; worst path −47% |
| Small machine | A $10k reserve backing $3,000 legendary cards: median +312%, worst path −67% |
| Cold start | Too small a seed or too high a risk factor deadlocks, hence the revisions in section 6 |

Full tables in `sim/results.md`. **Model limits**: reference value equals market value and the oracle has no error; player behaviour shares are fixed; consignment arrivals are exogenous, with no feedback where higher yield attracts more listings. That last point would make real inventory deeper, sales slower and APRs lower, but it does not change the conclusion that every party earns.

### 7.2 Party by party

| Role | Will they come? | Why | Biggest concern |
|---|---|---|---|
| Holders | **Yes, the easiest to bootstrap** | About 12–20% more than platform buybacks, sales in days, yield while waiting | Whether custodians restrict their NFTs from third-party programs |
| Creators | Mid-sized and up, yes | About $1,250 per month at $50k monthly flow, about $3,750 at $150k; much more if they are also the seed LP | Small streamers' flow cannot support meaningful income |
| Players | Demand is proven | On-chain draws run $250–320M per month; our pitch is transparency, verifiable returns and creator content | Players chase thrills, not expected value; transparency alone may not bring new players |
| LPs | They will come early | Extremely high median returns | Returns will compress; single machines have deep tail losses; LP shares may be deemed securities |
| Custodians | Neutral to positive | A new demand pool for their NFTs, plus redemption fees | Collector Crypt is itself a draw platform and a direct competitor |

### 7.3 Where it could really fail

1. **Custodian lockout.** If Collector Crypt's cards are Metaplex programmable NFTs (pNFTs), the issuer can use rule sets to restrict which programs may hold them. **This must be verified with on-chain data before building.** Countermeasures: integrate several custodians, negotiate adapter partnerships, or share protocol fees with custodians.
2. **Regulation.** Paying for random prizes is treated as gambling in many jurisdictions, and raffles are closer to lotteries. v1's compliance structure (page 16) still applies. v2 additionally requires every machine to display the real-cost table from section 4.5.
3. **Traffic.** Supply comes easily, but if creators bring no players, sellers wait for sales that never come and supply leaves. So stage 0's gates must track both listings and spin flow.

### 7.4 Kill criteria

| Metric | Target at the end of stage 0 | Below this, stop and redesign |
|---|---|---|
| Median days to sale for non-legendary consignments | ≤7 days | >21 days |
| Consignor proceeds / reference | ≥98% | <93% |
| Sellers relisting within 30 days | ≥50% | <25% |
| Actual return vs displayed | within ±2% | beyond ±3% |
| Insolvencies | 0 | >0 |
| 30-day repeat spin rate | ≥30% | <15% |

---

## 8. Disruption and durability

### 8.1 Flywheel

```
More cards listed → deeper tiers, more themed machines → more players → cards sell faster, steadier yield
      ↑                                                                              ↓
      └──────────────── Holders see: about 12–20% more than buybacks ←───────────────┘
```

This is a two-sided network: the machines with the deepest supply have the best odds and the most themes and attract the most players; the machines with the most players sell fastest and attract the most supply. Incumbents hold their own inventory, so their supply is limited by their balance sheet; Podmatic's supply comes from every holder and has no cap.

### 8.2 Durability: cards keep circulating

About 60% of won cards are sold back or traded in and return to the vault to be relisted. In steady state a card is drawn about 2.5 times before leaving the system (in the simulation's 90-day window recycled cards were 53% of draws, about 2.1 times). So:

> **Every $100 of cards listed brings about $240–280 of spin flow on average** (2.1–2.5 draws × $100 ÷ 89% return).

Protocol income comes from card turnover, not one-off pack openings. As long as cards keep circulating, flow continues; new listings only have to replace the 40% players take home.

### 8.3 Moats

| Moat | How it forms |
|---|---|
| Inventory depth | Listing yield and circulation royalties keep holders in the system; deeper inventory means faster sales |
| Standard denominations and credits | Credits only move between Podmatic machines, so players' winnings stay in the ecosystem |
| Creator relationships | Creators' machines, leaderboards, historical returns and fans accumulate on chain; switching is costly |
| Neutrality | The protocol does not compete with any creator or custodian, so everyone is willing to plug in |

### 8.4 How incumbents might respond

| Response | Impact | Counter |
|---|---|---|
| Raise buybacks, e.g. to 95% | Our advantage for holders narrows | Their margin disappears with it; we still have inventory yield and royalties |
| Block their NFTs from third-party programs | We lose the first custodian | Multiple custodians in parallel; Courtyard; adapter revenue sharing |
| Launch their own open machines | Direct competition | They are both operator and inventory holder, so less neutral than a protocol; frontends and creators prefer a neutral protocol |
| Plug in as a custodian | The best outcome | Share revenue with custody adapters, e.g. 10% of protocol fees |

---

## 9. Product

### 9.1 Holders (list in three steps)

1. Connect a wallet; the router detects eligible cards and shows the recommended machine, expected days to sale and current APR for each.
2. Pick an exit per card: consign and make markets, instant sale to the vault, card-to-LP, or whole-card raffle. The default is consignment at a fair ask.
3. Confirm with one click. Then track yield, reprice and claim from the dashboard.

### 9.2 Creators (open a machine in five minutes)

1. Choose a denomination and machine type.
2. Choose an odds preset and target return, narrow each tier's band with sliders, and set admission rules.
3. Apply for seed reserve from the bootstrap vault, or deposit it yourself.
4. Get a machine page, embeddable card and livestream overlay.
5. Track flow, inventory, sellers and historical returns on the dashboard.

### 9.3 Players

Everything from v1's gameplay design (page 10) stays: water-level bar, pity, upgrade spins, group spins, creator machines, live pull feed, seller dashboard. v2 adds:

- **Real-cost card**: every machine page permanently shows the table from section 4.5.
- **Raffles**: grail pages show tickets sold, a countdown and draw history.

---

## 10. v1 → v2 changes

| Item | v1 | v2 |
|---|---|---|
| Narrative | Uniswap for gacha pools | A market-making protocol for collectibles: spinning is trading, listing is market making |
| Seller income | Ask when drawn | Ask + inventory yield (curve) + circulation royalty; plus three more exits: instant sale, card-to-LP, raffles |
| Tier assignment | Ask | Reference value |
| Return | Measured at the ask; creator-fixed odds with a range check | Measured in reference value; creator sets shape and target; contract solves every spin |
| In-tier weight | (V/a)^4 | (V/a)^3, clamped to 0.5–2x |
| Ask cap | 105% of reference | 105% × min(7-day average, latest median) |
| Spin price | Any | Standard denominations 25 / 50 / 100 / 250 / 1,000 |
| Tiers | Creator-defined | Standard multiples, creators can only narrow; each tier ≤3x; top ≤60x |
| Very large cards | No solution | Whole-card raffles |
| Pity threshold | 30 spins | 40 spins, auto-raised when the pool is short |
| Cold start | Zero-capital machines | Minimum reserve of 100x the spin price with a 0.1 risk factor + bootstrap vault + sell-back buffer |
| Machine types | One | Open, curated, creator-stocked |
| Money waterfall | Protocol 1.5 / creator 2.5 / frontend 1 / reserve 95 | Adds a 2% inventory yield pool and a 1% pity pool; reserve 92 |

---

## 11. On-chain additions

On top of v1's accounts and instructions (pages 17–18):

**Accounts**

| Account | Contents |
|---|---|
| TierYield | Accumulated yield per unit of value per tier (like MasterChef's accRewardPerShare), last update time, current days of coverage |
| Listing (extended) | Adds a reference value snapshot, rewardDebt, yield start time and original consignor (for the royalty) |
| VaultBid | The vault's standing bid per tier: price ratio, size, on/off |
| Raffle | Whole-card raffle: NFT, ask, ticket price, ticket count, tickets sold, deadline, randomness request |
| Series | Series: machine list, credit settlement rules |
| BootstrapVault | Shared bootstrap vault: total funds, share of each machine |

**Instructions**

- `claim_yield`: claim inventory yield and royalties. Yield updates lazily: a tier's accumulator updates on every spin, listing, delisting and claim, with no daily push.
- `sell_to_vault`: instant sale to the vault.
- `card_to_lp`: deposit a card for LP shares.
- `create_raffle`, `buy_tickets`, `settle_raffle`, `refund_raffle`: whole-card raffles.
- `propose_params`, `apply_params`: creator parameter changes with a 24-hour timelock.
- `bootstrap_allocate`: the bootstrap vault allocates seed reserve to a new machine.

`fulfill_spin`'s tier selection switches to the return lock of section 4.3. That requires reading every tier's weighted expected value on each spin. v1's Fenwick tree already stores prefix sums of in-tier weights; adding one more tree for "weight × reference value" keeps the complexity logarithmic.

---

## 12. New open questions

1. Are Collector Crypt's cards pNFTs, and do their rule sets restrict third-party programs? (Highest priority: decides whether the first custodian is usable.)
2. The yield curve's parameters (8–100% APR, 3–30 days of coverage) need calibration against real listing behaviour on testnet.
3. Are card-to-LP shares securities? Should they be offered only in certain jurisdictions?
4. Are raffles lotteries in target jurisdictions? This needs its own legal opinion.
5. How much should the bootstrap vault allocate to each new machine, and how should creators be screened?
6. Is a 2% circulation royalty enough to influence where holders list? Should it scale with machine flow?
7. When should cross-machine credit settle: in real time at spin, or in periodic batches?
8. Of v1's eight open questions, three are answered here: the return floor (85%), the weight exponent (changed to 3) and the profit of zero-LP machines (goes to the seed LP's shares). The other five remain open.
