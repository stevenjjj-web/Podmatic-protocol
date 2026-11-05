#!/usr/bin/env python3
"""Premium pricing for non-fungible collection NFTs (trait-priced PFP collections such as SMB).

Every NFT in a collection is different: true value = floor x premium multiple, from 1x to tens of x.
Compares ways of pricing NFTs that enter a draw machine:

  A. Oracle cap: an outside trait-appraisal model values the NFT; the ask may not exceed 105% of it (common practice).
  B. Floor only: every NFT is bought at the collection floor (collection bids / floor pools).
  C. Seller self-guarantee: the seller sets the ask; within 72 hours the winner may return the NFT for x times the ask,
     voiding the sale; the NFT goes back to the seller, who pays a 3% return fee. (Counterexample: does self-guarantee work?)
  D. Committed-bid valuation: an NFT's value = the highest committed bid that covers it (collection or trait bid).
     Sellers only give a floor; an NFT enters the machine if floor <= value x (1 + u) and settles at value x (1 + u);
     the winner can always sell the NFT to the bid that defines its value.

Metrics:
  - Listing rate: share of holders willing to put the NFT in a machine (by rarity)
  - Seller take / true value (completed sales only)
  - Player gets / displayed value: whether the displayed return is credible
  - Return rate

Model:
  - Rarity classes: near floor (1-1.3x, 70%), mid (1.3-3x, 22%), rare (3-10x, 6%),
    ultra rare (10-40x, 2%).
  - Liquidity discount: rarer is harder to sell. Immediately realizable share of true value: 97% / 90% / 82% / 72%.
  - Appraisal-model error grows with rarity: 8% / 20% / 35% / 50% (log sd).
  - Holders misjudge their own NFT by 10%; reservation prices have a median 5% above true value.
  - Winners misjudge realizable value by 15%.
  - Committed bids: near-floor NFTs are valued at the floor bid (98% of floor). Other NFTs are covered by a trait bid
    with some probability (90% / 70% / 40%) priced at 80-95% / 70-90% / 55-85% of true value;
    without a trait bid they can only be valued at the floor bid.

Usage:
  python3 sim/premium_sim.py > sim/premium_results.md
"""

import math

import numpy as np

N = 200_000  # candidate holders
CLASSES = [
    # name, share, min multiple, max multiple, liquidity discount, appraisal error
    ("Near floor 1-1.3x", 0.70, 1.0, 1.3, 0.97, 0.08),
    ("Mid 1.3-3x", 0.22, 1.3, 3.0, 0.90, 0.20),
    ("Rare 3-10x", 0.06, 3.0, 10.0, 0.82, 0.35),
    ("Ultra rare 10-40x", 0.02, 10.0, 40.0, 0.72, 0.50),
]
SELLER_SD = 0.10
RESERVE_MU, RESERVE_SD = 0.05, 0.10
WINNER_SD = 0.15
ORACLE_CAP = 1.05
FLOOR_BID = 0.98
PENALTY = 0.03


def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def population(rng):
    probs = np.array([c[1] for c in CLASSES])
    cls = rng.choice(len(CLASSES), size=N, p=probs)
    lo = np.array([c[2] for c in CLASSES])[cls]
    hi = np.array([c[3] for c in CLASSES])[cls]
    mult = np.exp(rng.uniform(np.log(lo), np.log(hi)))
    liq = np.array([c[4] for c in CLASSES])[cls]
    osd = np.array([c[5] for c in CLASSES])[cls]
    m = mult  # priced in floor units
    r = m * np.exp(rng.normal(RESERVE_MU, RESERVE_SD, N))
    m_hat = m * np.exp(rng.normal(0, SELLER_SD, N))
    oracle = m * np.exp(rng.normal(0, osd))
    winner = m * liq * np.exp(rng.normal(0, WINNER_SD, N))  # what the winner believes they can realize
    return dict(cls=cls, m=m, liq=liq, r=r, m_hat=m_hat, oracle=oracle, winner=winner)


def summarize(name, pop, listed, ask, value_to_player, seller_get, sold, returned):
    rows = []
    for k, c in enumerate(CLASSES + [("All", 1, 0, 0, 0, 0)]):
        sel = (pop["cls"] == k) if k < len(CLASSES) else np.ones(N, dtype=bool)
        lst = listed & sel
        sd = sold & sel
        rows.append(dict(
            cls=c[0],
            list_rate=lst.mean() / sel.mean(),
            seller_ratio=seller_get[sd].sum() / pop["m"][sd].sum() if sd.any() else float("nan"),
            player_ratio=value_to_player[lst].sum() / ask[lst].sum() if lst.any() else float("nan"),
            return_rate=(returned & sel).sum() / lst.sum() if lst.any() else float("nan"),
        ))
    return name, rows


def mech_oracle(pop):
    cap = ORACLE_CAP * pop["oracle"]
    listed = pop["r"] <= cap
    ask = cap
    sold = listed
    zero = np.zeros(N, dtype=bool)
    return summarize("A. Oracle cap", pop, listed, ask, pop["m"], ask, sold, zero)


def mech_floor(pop):
    ask = np.full(N, FLOOR_BID)
    listed = pop["r"] <= ask
    zero = np.zeros(N, dtype=bool)
    return summarize("B. Floor only", pop, listed, ask, pop["m"], ask, listed, zero)


def mech_guarantee(pop, x_by_class):
    """Sellers pick the ask that maximizes expected payoff given their information; winners return based on their own judgement."""
    x = np.array(x_by_class)[pop["cls"]]
    grid = np.linspace(0.8, 2.0, 61)
    best_u = np.full(N, -np.inf)
    best_a = np.zeros(N)
    # seller's expectation of the winner's judgement: median = own estimate x liquidity discount, combining both errors
    sd = math.sqrt(WINNER_SD ** 2 + SELLER_SD ** 2)
    ln_exp = np.log(pop["m_hat"] * pop["liq"])
    for g in grid:
        a = g * pop["m_hat"]
        z = (ln_exp - np.log(x * a)) / sd
        pk = 0.5 * (1 + np.vectorize(math.erf)(z / math.sqrt(2)))
        u = pk * a + (1 - pk) * (pop["r"] - PENALTY * a)
        better = u > best_u
        best_u[better] = u[better]
        best_a[better] = a[better]
    listed = best_u > pop["r"] * 1.001
    ask = best_a
    returned = listed & (x * ask > pop["winner"])
    sold = listed & ~returned
    # player gets the NFT (true value) if kept, or x times the ask in cash if returned
    value = np.where(returned, x * ask, pop["m"])
    seller_get = np.where(sold, ask, 0.0)
    label = "C. Seller self-guarantee (return ratio " + " / ".join(f"{v:.0%}" for v in x_by_class) + ")"
    return summarize(label, pop, listed, ask, value, seller_get, sold, returned)


BID_COVER = [1.0, 0.90, 0.70, 0.40]
BID_RANGE = [(0.98, 0.98), (0.80, 0.95), (0.70, 0.90), (0.55, 0.85)]


# Mature bid market: trait bids cover more NFTs and bid closer to true value
BID_COVER_MATURE = [1.0, 0.97, 0.90, 0.70]
BID_RANGE_MATURE = [(0.98, 0.98), (0.88, 0.98), (0.82, 0.95), (0.70, 0.92)]


def mech_committed_bids(pop, rng, u, cover_by_class=BID_COVER, range_by_class=BID_RANGE, label="early"):
    """Value comes from committed bids; sellers only give a floor."""
    cls = pop["cls"]
    cover = rng.random(N) < np.array(cover_by_class)[cls]
    lo = np.array([b[0] for b in range_by_class])[cls]
    hi = np.array([b[1] for b in range_by_class])[cls]
    trait_bid = pop["m"] * rng.uniform(lo, hi)
    g = np.where(cover, np.maximum(trait_bid, FLOOR_BID), FLOOR_BID)
    price = g * (1 + u)
    listed = pop["r"] <= price
    # winner keeps it if they can sell for more outside, otherwise sells to the bid
    value = np.maximum(pop["m"] * pop["liq"], g)
    zero = np.zeros(N, dtype=bool)
    # displayed value is the redeemable bid g
    return summarize(f"D. Committed-bid valuation, {label} bid market (settlement premium u = {u:.0%})", pop, listed, g, value, price, listed, zero)


def pct(v):
    return "—" if v != v else f"{v * 100:.1f}%"


def main():
    rng = np.random.default_rng(7)
    pop = population(rng)
    results = [
        mech_oracle(pop),
        mech_floor(pop),
        mech_guarantee(pop, [0.90, 0.90, 0.90, 0.90]),
        mech_guarantee(pop, [0.90, 0.88, 0.80, 0.72]),
        mech_committed_bids(pop, np.random.default_rng(11), 0.03),
        mech_committed_bids(pop, np.random.default_rng(11), 0.03,
                            BID_COVER_MATURE, BID_RANGE_MATURE, "mature"),
    ]
    out = ["# Premium pricing comparison for collection NFTs", "",
           "Generated by `python3 sim/premium_sim.py`. Assumptions are in the script's docstring.", ""]
    for name, rows in results:
        out += [f"### {name}", "",
                "| Rarity | Listing rate | Seller take / true value | Player gets / displayed value | Return rate |",
                "|---|---|---|---|---|"]
        for r in rows:
            out.append(f"| {r['cls']} | {pct(r['list_rate'])} | {pct(r['seller_ratio'])} "
                       f"| {pct(r['player_ratio'])} | {pct(r['return_rate'])} |")
        out.append("")
    # Sensitivity of seller self-guarantee to the return penalty
    global PENALTY
    out += ["### C: sensitivity to the return penalty (all NFTs)", "",
            "| Return penalty | Return ratio | Listing rate | Seller take / true value | Player gets / displayed value | Return rate |",
            "|---|---|---|---|---|---|"]
    for pen in (0.03, 0.10, 0.20, 0.30):
        PENALTY = pen
        for x in ([0.90, 0.88, 0.80, 0.72], [0.85, 0.80, 0.72, 0.62]):
            _, rows = mech_guarantee(pop, x)
            r = rows[-1]
            out.append(f"| {pen:.0%} | {' / '.join(f'{v:.0%}' for v in x)} | {pct(r['list_rate'])} "
                       f"| {pct(r['seller_ratio'])} | {pct(r['player_ratio'])} | {pct(r['return_rate'])} |")
    print("\n".join(out))


if __name__ == "__main__":
    main()
