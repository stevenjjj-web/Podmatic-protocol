#!/usr/bin/env python3
"""Podmatic pricing comparison: seller asks capped by an oracle (v2) vs a price curve.

The price curve only applies to interchangeable assets: one model of graded card, or the floor of an NFT collection.
Trait premiums of collection NFTs are covered by premium_sim.py.

Both mechanisms run under the same market conditions and are compared on:
  - Valuation accuracy: true market value of the card a player receives / the protocol's valuation (drives the real return)
  - Settlement premium: what the protocol pays the seller / the card's true market value
  - Vault cost: net cash the vault spends per $1 of true value delivered
  - Price tracking error: deviation of the protocol price from the true market value

Market model:
  - One tier (the Rare tier of a $50 machine) holds K card models (card x grader x grade);
    cards of the same model are economically interchangeable.
  - Each model has a hidden true market value M that random-walks daily with occasional jumps.
  - The external oracle O = M seven days ago x a persistent error (about 10% sd), like PriceCharting-style sources.
  - Ordinary holders arrive over time; their reservation price r has a median 5% above market.
  - Arbitrageurs can buy and sell the same model on outside markets at M +/- friction.
  - Spins are random, uninformed demand; a winner sells back only if the sell-back price beats the outside net price (informed).

Usage:
  python3 sim/pricing_sim.py --runs 20 > sim/pricing_results.md
"""

import argparse
import math
from bisect import insort

import numpy as np

K = 150  # number of models
DAYS = 180
DRAWS_PER_DAY = 80
HOLDERS_PER_DAY = 60
LO, HI = 75.0, 200.0  # tier band (USD)
VOL = 0.015  # daily volatility of the true market value
JUMP_P, JUMP_SD = 0.005, 0.20  # jumps
ORACLE_LAG = 7
ORACLE_SD, ORACLE_RHO = 0.10, 0.97
ARB_COST = 0.015  # arbitrageur friction on outside markets
PLAYER_EXIT = 0.97  # a player's net proceeds when selling outside
PATIENCE = 60

# v2: seller ask capped by an oracle
ASK_CAP = 1.05
WEIGHT_EXP = 3.0

# v3: per-model price curve
FEE = 0.02  # half spread: bid = P(1-FEE), ask = P(1+FEE)
DELTA = 0.02  # price moves 2% per unit in or out
DRIFT_UP = 0.01  # +1% per day when out of stock
DRIFT_DOWN = 0.005  # -0.5% per day above target inventory
TARGET_UNITS = 6
TWAP_DAYS = 3  # TWAP window used for settlement
ARB_MAX = 20  # max arbitrage units per model per day


class Market:
    def __init__(self, rng):
        self.rng = rng
        self.m = np.exp(rng.uniform(math.log(LO), math.log(HI), K))
        self.hist = [self.m.copy() for _ in range(ORACLE_LAG + 1)]
        self.eps = rng.normal(0, ORACLE_SD, K)

    def step(self):
        rng = self.rng
        r = rng.normal(0, VOL, K)
        jump = rng.random(K) < JUMP_P
        r[jump] += rng.normal(0, JUMP_SD, jump.sum())
        self.m = self.m * np.exp(r)
        self.hist.append(self.m.copy())
        self.hist.pop(0)
        self.eps = ORACLE_RHO * self.eps + math.sqrt(1 - ORACLE_RHO ** 2) * rng.normal(0, ORACLE_SD, K)

    @property
    def oracle(self):
        return self.hist[0] * np.exp(self.eps)


def holder_reservation(rng, m):
    return m * math.exp(rng.normal(0.05, 0.10))


def new_stats():
    return dict(value_delivered=0.0, valuation=0.0, paid_sellers=0.0, true_of_paid=0.0,
                vault_cash=0.0, draws=0, track=[], holder_fills=0, holder_wait=[],
                arb_in=0, arb_out=0)


def finish(st, vault_units_value):
    # Vault net cost = net cash out - ending inventory at true market value
    net = st["vault_cash"] - vault_units_value
    return dict(
        accuracy=st["value_delivered"] / st["valuation"],
        seller_premium=st["paid_sellers"] / st["true_of_paid"],
        vault_cost=net / st["value_delivered"],
        track=np.median(st["track"]) if st["track"] else float("nan"),
        track90=np.percentile(st["track"], 90) if st["track"] else float("nan"),
        fills=st["holder_fills"],
        wait_honest=np.median([w for w, h in st["holder_wait"] if h] or [float("nan")]),
        wait_greedy=np.median([w for w, h in st["holder_wait"] if not h] or [float("nan")]),
        share_honest=np.mean([h for _, h in st["holder_wait"]]) if st["holder_wait"] else float("nan"),
        arb_in=st["arb_in"], arb_out=st["arb_out"], draws=st["draws"],
    )


def run_ask_model(seed):
    """v2: ask <= 105% x oracle; valued at the oracle; settled at the ask; 88% buyback."""
    rng = np.random.default_rng(seed)
    mk = Market(rng)
    listings = [[] for _ in range(K)]  # (ask, t, kind); kind: 0 holder, 1 arbitrageur, 2 vault
    honest = {}  # holder listing -> whether its reservation was at or below market when listed
    st = new_stats()
    for day in range(DAYS):
        mk.step()
        o = mk.oracle
        cap = ASK_CAP * o
        # drop holder listings that expired or exceed the cap
        for j in range(K):
            listings[j] = [x for x in listings[j]
                           if not (x[2] == 0 and (day - x[1] > PATIENCE or x[0] > 1.15 * o[j]))]
        # holders list only if their reservation is under the cap; ask between reservation and cap
        for _ in range(rng.poisson(HOLDERS_PER_DAY)):
            j = rng.integers(K)
            r = holder_reservation(rng, mk.m[j])
            if r <= cap[j]:
                ask = min(cap[j], max(r, o[j] * rng.uniform(0.98, 1.05)))
                listings[j].append((ask, day, 0))
                honest[(j, day, ask)] = r <= mk.m[j]
        # arbitrageurs buy outside and list when the cap exceeds their cost
        for j in range(K):
            if cap[j] > mk.m[j] * (1 + ARB_COST):
                n_arb = sum(1 for x in listings[j] if x[2] == 1)
                for _ in range(max(0, 3 - n_arb)):
                    listings[j].append((cap[j], day, 1))
                    st["arb_in"] += 1
        # spins
        for _ in range(DRAWS_PER_DAY):
            w, idx = [], []
            for j in range(K):
                for i, (a, _, _) in enumerate(listings[j]):
                    w.append((o[j] / a) ** WEIGHT_EXP)
                    idx.append((j, i))
            if not w:
                continue
            w = np.array(w)
            j, i = idx[int(rng.choice(len(w), p=w / w.sum()))]
            ask, t0, kind = listings[j].pop(i)
            st["draws"] += 1
            st["valuation"] += o[j]
            st["value_delivered"] += mk.m[j]
            st["track"].append(abs(o[j] / mk.m[j] - 1))
            if kind != 2:
                st["vault_cash"] += ask
                st["paid_sellers"] += ask
                st["true_of_paid"] += mk.m[j]
                if kind == 0:
                    st["holder_fills"] += 1
                    st["holder_wait"].append((day - t0, honest[(j, t0, ask)]))
            # players sell back only if it beats the outside net price
            back = 0.88 * min(ask, o[j])
            if back >= PLAYER_EXIT * mk.m[j]:
                st["vault_cash"] += back
                listings[j].append((o[j], day, 2))
    vault_value = sum(mk.m[j] for j in range(K) for x in listings[j] if x[2] == 2)
    return finish(st, vault_value)


def run_curve_model(seed):
    """v3: one price curve per model; -2% per unit in, +2% per unit out; holders only set floors."""
    rng = np.random.default_rng(seed)
    mk = Market(rng)
    p = mk.oracle.copy()  # cold start from the noisy oracle
    p_hist = [p.copy()]
    floors = [[] for _ in range(K)]  # holder consignments: (t, floor, floor at or below market), first in first out
    vault = np.zeros(K, dtype=int)  # vault-owned inventory
    st = new_stats()

    def in_range(j):
        return [x for x in floors[j] if x[1] <= p[j]]

    for day in range(DAYS):
        mk.step()
        twap = np.mean(p_hist[-TWAP_DAYS:], axis=0)
        for j in range(K):
            floors[j] = [x for x in floors[j] if day - x[0] <= PATIENCE]
        # holders only give a floor; above the current price they are out of range and cannot be drawn
        for _ in range(rng.poisson(HOLDERS_PER_DAY)):
            j = rng.integers(K)
            r = holder_reservation(rng, mk.m[j])
            floors[j].append((day, r, r <= mk.m[j]))
        # two-sided arbitrage when the price deviates from outside by more than spread + friction
        for j in range(K):
            for _ in range(ARB_MAX):
                if p[j] * (1 - FEE) > mk.m[j] * (1 + ARB_COST):
                    st["vault_cash"] += p[j] * (1 - FEE)
                    vault[j] += 1
                    p[j] *= 1 - DELTA
                    st["arb_in"] += 1
                elif p[j] * (1 + FEE) < mk.m[j] * (1 - ARB_COST) and vault[j]:
                    # direct buys only take vault inventory: consigned cards face random spins only and cannot be picked off
                    st["vault_cash"] -= p[j] * (1 + FEE)
                    vault[j] -= 1
                    p[j] *= 1 + DELTA
                    st["arb_out"] += 1
                else:
                    break
        # time drift: up when out of stock, down when overstocked
        for j in range(K):
            n = vault[j] + len(in_range(j))
            if n == 0:
                p[j] *= 1 + DRIFT_UP
            elif n > TARGET_UNITS:
                p[j] *= 1 - DRIFT_DOWN
        # spins: uniform over all in-range units
        for _ in range(DRAWS_PER_DAY):
            counts = np.array([vault[j] + len(in_range(j)) for j in range(K)], dtype=float)
            if counts.sum() == 0:
                continue
            j = int(rng.choice(K, p=counts / counts.sum()))
            value = min(p[j], twap[j]) * (1 - FEE)  # value = lower of spot and TWAP, at the bid
            settle = twap[j]  # consignors settle at TWAP so a single pump cannot move settlement
            st["draws"] += 1
            st["valuation"] += value
            st["value_delivered"] += mk.m[j]
            st["track"].append(abs(value / mk.m[j] - 1))
            if rng.random() < vault[j] / counts[j]:
                vault[j] -= 1
            else:
                first = min(in_range(j))
                floors[j].remove(first)
                st["vault_cash"] += settle
                st["paid_sellers"] += settle
                st["true_of_paid"] += mk.m[j]
                st["holder_fills"] += 1
                st["holder_wait"].append((day - first[0], first[2]))
            p[j] *= 1 + DELTA
            # players sell back at the bid only if it beats the outside net price
            bid = p[j] * (1 - FEE)
            if bid >= PLAYER_EXIT * mk.m[j]:
                st["vault_cash"] += bid
                vault[j] += 1
                p[j] *= 1 - DELTA
        p_hist.append(p.copy())
    return finish(st, float(np.sum(vault * mk.m)))


def pct(x, d=1):
    return f"{x * 100:.{d}f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=20)
    args = ap.parse_args()
    rows = {"v2 ask + oracle cap": run_ask_model, "v3 price curve": run_curve_model}
    out = ["# Pricing mechanism comparison", "",
           f"Generated by `python3 sim/pricing_sim.py --runs {args.runs}`. Assumptions are in the script's docstring.",
           f"One tier, {K} models, {DAYS} days, {DRAWS_PER_DAY} spins/day; {args.runs} paths per mechanism. Medians, worst path in parentheses.", "",
           "| Mechanism | Valuation accuracy (true value / valuation) | Settlement premium (paid to seller / true value) | Vault net cost per $1 of true value | Valuation error median / P90 | Holder fills | Share with floor <= market | Median days to sale: floor <= market / floor > market | Arbitrage in / out |",
           "|---|---|---|---|---|---|---|---|---|"]
    for name, fn in rows.items():
        res = [fn(1000 + r) for r in range(args.runs)]
        acc = [r["accuracy"] for r in res]
        prem = [r["seller_premium"] for r in res]
        cost = [r["vault_cost"] for r in res]
        out.append(
            f"| {name} | {pct(np.median(acc))} ({pct(min(acc))}) | {pct(np.median(prem))} ({pct(max(prem))}) "
            f"| ${np.median(cost):.3f} (${max(cost):.3f}) | {pct(np.median([r['track'] for r in res]))} / "
            f"{pct(np.median([r['track90'] for r in res]))} | {np.median([r['fills'] for r in res]):,.0f} "
            f"| {pct(np.median([r['share_honest'] for r in res]), 0)} "
            f"| {np.median([r['wait_honest'] for r in res]):.1f} / {np.median([r['wait_greedy'] for r in res]):.1f} "
            f"| {np.median([r['arb_in'] for r in res]):,.0f} / "
            f"{np.median([r['arb_out'] for r in res]):,.0f} |")
    print("\n".join(out))


if __name__ == "__main__":
    main()
