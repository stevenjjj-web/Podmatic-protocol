#!/usr/bin/env python3
"""Podmatic v2 economic simulation.

Two parts:
  1. presets  -- analytic statistics for the three odds presets (return, hit rate, volatility).
  2. simulate -- Monte Carlo of one machine: holders consign over time, players spin,
     sell back / trade in / keep, inventory yield accrues daily, vault LPs fund the reserve.

Usage:
  python3 sim/podmatic_sim.py              # all scenarios, Markdown to stdout
  python3 sim/podmatic_sim.py --runs 10    # fewer paths, faster

Model assumptions (all adjustable in Scenario / constants):
  - Reference values are log-uniform within each tier band; the reference value is the market value (no oracle error).
  - Tiers are assigned by reference value, player return is measured in reference value, sellers are paid their ask.
  - Seller ask styles: 30% eager (0.92-0.97), 50% fair (0.98-1.02), 20% reluctant (1.03-1.05).
  - After a win: 35% sell back for cash (88%), 25% trade in for credit (95%), 40% keep.
  - Players spend credit first when they have it.
  - Recycled cards held by the vault are relisted at reference value, earn no yield, and are marked at 85% of reference.
"""

import argparse
import math
from dataclasses import dataclass, field

import numpy as np

P = 50.0  # example machine spin price (USD)
TIER_NAMES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"]
# Tier bands as multiples of the spin price (protocol standard tiers)
BANDS = [(0.2, 0.6), (0.6, 1.5), (1.5, 4.0), (4.0, 12.0), (12.0, 60.0)]

# Per-spin money waterfall (share of spin price)
FEE_PROTOCOL = 0.015
FEE_CREATOR = 0.025
FEE_FRONTEND = 0.01
FEE_INVENTORY = 0.02  # inventory yield pool: fixed per spin, topped up by the reserve when short
INV_CAP = 0.06  # inventory yield cap: 6% of the day's flow
# Inventory yield curve: APR set by a tier's days of coverage = consigned value / expected daily payout of the tier
CURVE_D_LO, CURVE_D_HI = 3.0, 30.0  # under 3 days of coverage pays the max APR, over 30 days the min
APR_MAX, APR_MIN = 1.00, 0.08
FEE_PITY = 0.01  # pity pool
TO_RESERVE = 1.0 - FEE_PROTOCOL - FEE_CREATOR - FEE_FRONTEND - FEE_INVENTORY - FEE_PITY

SELLBACK_RATE = 0.88
TRADEIN_RATE = 0.95
P_SELLBACK = 0.35
P_TRADEIN = 0.25
WEIGHT_EXP = 3.0  # in-tier weight (V/a)^3
ASK_CAP = 1.05  # ask cap: 105% of reference
PAUSE_AT = 1.15  # asks above 115% of reference are paused
VAULT_MARK = 0.85  # NAV mark for recycled cards
SELLBACK_BUFFER = 20  # below 20 spins of reserve, cash sell-back becomes trade-in
RTP_FLOOR = 0.85  # protocol return floor
ROYALTY = 0.02  # circulation royalty: 2% of reference to the original consignor each time a recycled card is drawn again

# Relative shape of the non-common tiers; the common probability is solved by calibration
SHAPES = {
    "Steady": [22.0, 7.5, 2.2, 0.30],
    "Standard": [18.0, 7.0, 2.7, 0.25],
    "Chase": [12.0, 5.0, 2.0, 0.70],
}


def band_mean(lo, hi):
    return (hi - lo) / math.log(hi / lo)


def band_second_moment(lo, hi):
    return (hi * hi - lo * lo) / (2.0 * math.log(hi / lo))


def band_tail(lo, hi, x):
    """P(V >= x) under a log-uniform distribution."""
    if x <= lo:
        return 1.0
    if x >= hi:
        return 0.0
    return math.log(hi / x) / math.log(hi / lo)


TIER_MEANS = [band_mean(lo, hi) for lo, hi in BANDS]


def calibrate(shape, rtp):
    """Scale the non-common probabilities so the expected value (in spin-price multiples) equals rtp."""
    q = np.array(shape) / 100.0
    m = np.array(TIER_MEANS)
    s = (rtp - m[0]) / float(np.sum(q * (m[1:] - m[0])))
    probs = np.concatenate([[1.0 - s * q.sum()], s * q])
    assert probs.min() > 0, "shape incompatible with target return"
    return probs


def preset_stats(probs):
    ev = sum(p * m for p, m in zip(probs, TIER_MEANS))
    ev2 = sum(p * band_second_moment(lo, hi) for p, (lo, hi) in zip(probs, BANDS))
    sd = math.sqrt(ev2 - ev * ev)

    def tail(x):
        return sum(p * band_tail(lo, hi, x) for p, (lo, hi) in zip(probs, BANDS))

    return dict(ev=ev, sd=sd, hit1=tail(1.0), hit5=tail(5.0), hit20=tail(20.0))


def pity_cost(probs, threshold, session_len):
    """Expected pity cost as a share of the spin price.

    A wallet spins session_len times in a row. After `threshold` spins without rare or better,
    the next spin draws only from rare and above; the excess over the normal expected value is paid by the pity pool.
    """
    p_hit = float(sum(probs[2:]))
    ev_all = sum(p * m for p, m in zip(probs, TIER_MEANS))
    ev_rare = sum(p * m for p, m in zip(probs[2:], TIER_MEANS[2:])) / p_hit
    extra = ev_rare - ev_all
    # Dynamic programming over the current miss streak
    dist = np.zeros(threshold + 1)
    dist[0] = 1.0
    triggers = 0.0
    for _ in range(session_len):
        new = np.zeros_like(dist)
        triggers += dist[threshold]
        new[0] += dist[threshold]  # a pity spin always hits
        new[0] += dist[:threshold].sum() * p_hit
        new[1:threshold + 1] += dist[:threshold] * (1 - p_hit)
        dist = new
    return triggers * extra / session_len


# --------------------------------------------------------------------------
# Monte Carlo
# --------------------------------------------------------------------------


@dataclass
class Scenario:
    name: str
    spins_per_day: int
    lp_capital: float
    supply_mult: float = 1.0  # multiplier on third-party consignment arrivals
    drift: float = 0.0  # log price drift over the run; -0.29 is about -25%
    days: int = 90
    risk: float = 0.25
    preset: str = "Standard"
    rtp: float = 0.89  # draw return (in reference value), excluding the pity pool
    creator_seeded: bool = False  # reserve is entirely creator seed money, no outside LPs
    sellback: float = SELLBACK_RATE  # cash sell-back rate; about 96% (pool bid) under the v3 pricing layer
    tradein: float = TRADEIN_RATE


class TierBook:
    """Listings in one tier. V0 is the reference value at index 1; the live reference value is V0 * index."""

    def __init__(self):
        self.v0 = np.empty(0)
        self.ask = np.empty(0)
        self.external = np.empty(0, dtype=bool)
        self.listed_at = np.empty(0)
        self.yield_acc = np.empty(0)
        self.patience = np.empty(0)
        self.dirty = True

    def __len__(self):
        return len(self.v0)

    def add(self, v0, ask, external, t, patience, yacc=0.0):
        self.v0 = np.append(self.v0, v0)
        self.ask = np.append(self.ask, ask)
        self.external = np.append(self.external, external)
        self.listed_at = np.append(self.listed_at, t)
        self.yield_acc = np.append(self.yield_acc, yacc)
        self.patience = np.append(self.patience, patience)
        self.dirty = True

    def take(self, i):
        row = (self.v0[i], self.ask[i], self.external[i], self.listed_at[i],
               self.yield_acc[i], self.patience[i])
        keep = np.ones(len(self.v0), dtype=bool)
        keep[i] = False
        self.filter(keep)
        return row

    def filter(self, keep):
        self.v0 = self.v0[keep]
        self.ask = self.ask[keep]
        self.external = self.external[keep]
        self.listed_at = self.listed_at[keep]
        self.yield_acc = self.yield_acc[keep]
        self.patience = self.patience[keep]
        self.dirty = True

    def evaluate(self, idx, threshold):
        """Return (drawable weights, expected reference value in the tier), or (None, 0) if nothing is drawable.

        Drawable = not paused, and (vault-owned or ask <= water-level threshold).
        """
        if self.dirty or idx != self._idx:
            self._idx = idx
            self._v = self.v0 * idx
            active = self.ask <= PAUSE_AT * self._v
            self._w_full = np.where(active, (self._v / np.maximum(self.ask, 1e-9)) ** WEIGHT_EXP, 0.0)
            ext = self.external & active
            self._max_ext_ask = float(self.ask[ext].max()) if ext.any() else 0.0
            self._full = self._summarize(self._w_full)
            self.dirty = False
        if threshold >= self._max_ext_ask:
            return self._full
        w = np.where((~self.external) | (self.ask <= threshold), self._w_full, 0.0)
        return self._summarize(w)

    def _summarize(self, w):
        s = float(w.sum())
        if s <= 0:
            return None, 0.0
        return w, float(w @ self._v) / s


def seller_ask_multiplier(rng):
    u = rng.random()
    if u < 0.30:
        return rng.uniform(0.92, 0.97)
    if u < 0.80:
        return rng.uniform(0.98, 1.02)
    return rng.uniform(1.03, ASK_CAP)


def draw_value(rng, k):
    lo, hi = BANDS[k]
    return P * math.exp(rng.uniform(math.log(lo), math.log(hi)))


def tier_of(v):
    m = v / P
    for k, (lo, hi) in enumerate(BANDS):
        if lo <= m < hi or (k == len(BANDS) - 1 and lo <= m <= hi + 1e-9):
            return k
    return None


def pick(rng, w):
    c = np.cumsum(w)
    return min(int(np.searchsorted(c, rng.random() * c[-1], side="right")), len(w) - 1)


def inventory_apr(days_covered):
    """Inventory yield curve: thinner supply pays a higher APR."""
    s = min(1.0, max(0.0, (CURVE_D_HI - days_covered) / (CURVE_D_HI - CURVE_D_LO)))
    return APR_MIN + (APR_MAX - APR_MIN) * s


def run_once(sc: Scenario, seed: int):
    rng = np.random.default_rng(seed)
    base = calibrate(SHAPES[sc.preset], sc.rtp)
    n = sc.spins_per_day
    nt = len(BANDS)
    target = sc.rtp * P

    books = [TierBook() for _ in range(nt)]
    reserve = sc.lp_capital
    credit = 0.0
    risk = sc.risk
    arrival = sc.supply_mult * 0.5 * n * base  # third-party consignment arrivals (cards/day)

    def new_listing(k, t, idx):
        v = draw_value(rng, k)
        ask = v * seller_ask_multiplier(rng)
        books[k].add(v / idx, ask, True, t, rng.uniform(30, 120))

    for k in range(nt):
        for _ in range(max(3, int(round(5 * arrival[k])))):
            new_listing(k, -rng.uniform(0, 5), 1.0)

    stats = dict(
        requested=0, spins=0, prize_value=0.0, seller_paid=0.0, yield_paid=0.0,
        protocol=0.0, creator=0.0, frontend=0.0, pity=0.0,
        insolvent=0, sold=[[] for _ in range(nt)], delisted=0, tier_hits=np.zeros(nt),
        rtp_miss=0, degraded=0, royalty=0.0, recycled_draws=0, apr_days=[[] for _ in range(nt)],
    )
    nav_hist = []

    for day in range(sc.days):
        idx = math.exp(sc.drift * day / sc.days)

        # 1) Re-tier by live reference value; cards outside the machine's range leave (vault cards sold at 90%)
        moved = [[] for _ in range(nt)]
        for k in range(nt):
            b = books[k]
            if not len(b):
                continue
            v_now = b.v0 * idx
            keep = np.ones(len(b), dtype=bool)
            for i in range(len(b)):
                k2 = tier_of(v_now[i])
                if k2 == k:
                    continue
                keep[i] = False
                if k2 is None:
                    if b.external[i]:
                        stats["delisted"] += 1
                    else:
                        reserve += 0.9 * v_now[i]
                else:
                    moved[k2].append((b.v0[i], b.ask[i], b.external[i], b.listed_at[i],
                                      b.patience[i], b.yield_acc[i]))
            if not keep.all():
                b.filter(keep)
        for k in range(nt):
            for row in moved[k]:
                books[k].add(*row)

        # 2) Sellers delist after their patience runs out; paused asks are cut to reference with 30%/day probability
        for b in books:
            if not len(b):
                continue
            expired = b.external & (day - b.listed_at > b.patience)
            stats["delisted"] += int(expired.sum())
            if expired.any():
                b.filter(~expired)
            v_now = b.v0 * idx
            paused = b.external & (b.ask > PAUSE_AT * v_now)
            fix = paused & (rng.random(len(b)) < 0.3)
            b.ask[fix] = v_now[fix] * rng.uniform(0.95, 1.0, fix.sum())
            vault = ~b.external
            b.ask[vault] = v_now[vault]
            b.dirty = True

        # 3) New consignments (arrive at the start of the day)
        for k in range(nt):
            for _ in range(rng.poisson(arrival[k])):
                new_listing(k, day, idx)

        inv_pool = 0.0
        day_flow = 0.0

        # 4) The day's spins
        for j in range(n):
            t = day + j / n
            stats["requested"] += 1
            # use credit first (fees on credit spins are paid in cash by the reserve)
            use_credit = credit >= P and reserve >= (1.0 - TO_RESERVE) * P
            inflow = -(1.0 - TO_RESERVE) * P if use_credit else TO_RESERVE * P
            # the water level counts cash only: credit can only buy spins, and prizes are still capped by the water level
            threshold = risk * (reserve + inflow)
            evals = [b.evaluate(idx, threshold) for b in books]
            live = np.array([e[0] is not None for e in evals])
            ev = np.array([e[1] for e in evals])
            # Open if at least two tiers are drawable, the cheapest is at or below target and the richest at or above the floor.
            # If the water level cannot reach the target, this spin's return drops to the highest reachable value (not below the floor).
            if live.sum() < 2 or ev[live].min() > target or ev[live].max() < RTP_FLOOR * P:
                continue
            goal = min(target, float(ev[live].max()))
            if goal < target:
                stats["degraded"] += 1
            pi = np.where(live, base, 0.0)
            pi = pi / pi.sum()
            e = float(np.sum(pi * ev))
            live_idx = np.flatnonzero(live)
            top, low = live_idx[-1], live_idx[0]
            if e < goal:
                tt = (goal - e) / (ev[top] - e)
                pi = (1 - tt) * pi
                pi[top] += tt
            elif e > goal:
                tt = (e - goal) / (e - ev[low])
                pi = (1 - tt) * pi
                pi[low] += tt
            if abs(float(np.sum(pi * ev)) - goal) > 1e-6:
                stats["rtp_miss"] += 1

            if use_credit:
                credit -= P
            reserve += inflow
            stats["spins"] += 1
            stats["protocol"] += FEE_PROTOCOL * P
            stats["creator"] += FEE_CREATOR * P
            stats["frontend"] += FEE_FRONTEND * P
            stats["pity"] += FEE_PITY * P
            inv_pool += FEE_INVENTORY * P
            day_flow += P

            k = pick(rng, pi)
            i = pick(rng, evals[k][0])
            v0, ask, ext, listed_at, yacc, _ = books[k].take(i)
            v = v0 * idx
            stats["tier_hits"][k] += 1
            stats["prize_value"] += v
            if ext:
                if ask > reserve:
                    stats["insolvent"] += 1
                reserve -= ask
                stats["seller_paid"] += ask
                stats["sold"][k].append((t - listed_at, ask / v, yacc / ask, (ask + yacc) / v))
            else:
                reserve -= ROYALTY * v
                stats["royalty"] += ROYALTY * v
                stats["recycled_draws"] += 1
            cost_basis = min(ask, v)
            u = rng.random()
            if u < P_SELLBACK:
                amt = sc.sellback * cost_basis
                # sell-back buffer: keep at least SELLBACK_BUFFER spins of reserve after a cash sell-back, otherwise trade in
                if reserve - amt >= SELLBACK_BUFFER * P:
                    reserve -= amt
                else:
                    credit += sc.tradein * cost_basis
                books[k].add(v0, v, False, t, 1e9)
            elif u < P_SELLBACK + P_TRADEIN:
                credit += sc.tradein * cost_basis
                books[k].add(v0, v, False, t, 1e9)

        # 5) Inventory yield: each tier's APR comes from its days of coverage, paid to third-party listings by reference value.
        #    The yield pool pays first, the reserve tops up; the total is capped at INV_CAP of the day's flow; leftovers return to the reserve.
        owed = []
        for k, b in enumerate(books):
            if not len(b):
                owed.append(None)
                continue
            v_now = b.v0 * idx
            ok = b.external & (b.ask <= PAUSE_AT * v_now)
            value = np.where(ok, v_now, 0.0)
            daily_out = n * base[k] * TIER_MEANS[k] * P
            apr = inventory_apr(float(value.sum()) / daily_out)
            owed.append(value * apr / 365.0)
            stats["apr_days"][k].append(apr)
        total = sum(float(o.sum()) for o in owed if o is not None)
        scale = min(1.0, INV_CAP * day_flow / total) if total > 0 else 0.0
        paid = 0.0
        for k, o in enumerate(owed):
            if o is not None:
                books[k].yield_acc += o * scale
                paid += float(o.sum()) * scale
        reserve += inv_pool - paid
        stats["yield_paid"] += paid

        vault_value = sum(float(np.sum(VAULT_MARK * b.v0[~b.external] * idx)) for b in books)
        nav_hist.append(reserve - credit + vault_value)

    nav = np.array(nav_hist)
    peak = np.maximum.accumulate(np.concatenate([[sc.lp_capital], nav]))[1:]
    dd = float(np.min(nav / peak - 1.0))
    listed_end = [int(np.sum(b.external)) for b in books]
    return dict(stats=stats, nav_end=float(nav[-1]), max_dd=dd, listed_end=listed_end, base=base)


SCENARIOS = [
    Scenario("Base: 400 spins/day, LP $20k", 400, 20000),
    Scenario("Cold start A: 100 spins/day, $500 seed (10x spin), risk 1.0", 100, 500, risk=1.0, creator_seeded=True),
    Scenario("Cold start B: 100 spins/day, $2,000 seed (40x spin), risk 1.0", 100, 2000, risk=1.0, creator_seeded=True),
    Scenario("Cold start C: 100 spins/day, $5,000 seed (100x spin), risk 0.1", 100, 5000, risk=0.1, creator_seeded=True),
    Scenario("Small: 100 spins/day, LP $10k", 100, 10000),
    Scenario("Large: 1,500 spins/day, LP $50k", 1500, 50000),
    Scenario("Thin supply: half the consignment arrivals", 400, 20000, supply_mult=0.5),
    Scenario("Bear market: prices -25% over 90 days", 400, 20000, drift=math.log(0.75)),
    Scenario("Competitive: draw return raised to 93%", 400, 20000, rtp=0.93),
    Scenario("v3 market sell-back: sell back 96%, trade in 97%", 400, 20000, sellback=0.96, tradein=0.97),
]


def fmt_pct(x, digits=1):
    return f"{x * 100:.{digits}f}%"


def report_presets():
    out = ["## 1. Odds presets ($50 spin, 89% draw return, in reference value)", ""]
    out.append("| Preset | Common | Uncommon | Rare | Epic | Legendary | Return | Hit rate (>=1x) | >=5x | >=20x | Spin std dev | Pity cost (threshold 40 / 50-spin session) |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, shape in SHAPES.items():
        probs = calibrate(shape, 0.89)
        s = preset_stats(probs)
        pc = pity_cost(probs, 40, 50)
        cells = " | ".join(fmt_pct(p, 2) for p in probs)
        out.append(
            f"| {name} | {cells} | {fmt_pct(s['ev'])} | {fmt_pct(s['hit1'])} | {fmt_pct(s['hit5'], 2)} "
            f"| {fmt_pct(s['hit20'], 2)} | {s['sd']:.2f}x | {fmt_pct(pc, 2)} |")
    out.append("")
    out.append("Pity threshold sensitivity (Standard preset):")
    out.append("")
    out.append("| Threshold | 20-spin session | 50-spin session | 200-spin session |")
    out.append("|---|---|---|---|")
    probs = calibrate(SHAPES["Standard"], 0.89)
    for th in (20, 30, 40, 50):
        row = " | ".join(fmt_pct(pity_cost(probs, th, sl), 2) for sl in (20, 50, 200))
        out.append(f"| {th} | {row} |")
    out.append("")
    return out


def report_sim(runs):
    out = [f"## 2. Single-machine Monte Carlo ({runs} paths per scenario, 90 days, Standard preset)", ""]
    summary = ["| Scenario | Monthly flow | Demand served | Degraded spins | Player draw return | Yield / flow | Royalty / flow | Recycled share of draws | LP take / flow | LP NAV change 90d (median / worst) | Max drawdown (median / worst) | Creator / month | Protocol / month | Seller yield / month | Insolvencies |",
               "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    seller_tables = []
    for sc in SCENARIOS:
        res = [run_once(sc, 1000 + r) for r in range(runs)]
        months = sc.days / 30.0
        flow = np.median([r["stats"]["spins"] * P / months for r in res])
        rtp = np.median([r["stats"]["prize_value"] / (r["stats"]["spins"] * P) for r in res])
        if not sc.creator_seeded:
            g = [r["nav_end"] / sc.lp_capital - 1 for r in res]
            nav_cell = f"{fmt_pct(np.median(g), 0)} / {fmt_pct(np.min(g), 0)}"
            dds = [r["max_dd"] for r in res]
            dd_cell = f"{fmt_pct(np.median(dds), 0)} / {fmt_pct(np.min(dds), 0)}"
        else:
            nav = [r["nav_end"] for r in res]
            usd = lambda x: f"-${-x:,.0f}" if x < 0 else f"${x:,.0f}"
            nav_cell = f"seed NAV {usd(np.median(nav))} / {usd(np.min(nav))}"
            dd_cell = "—"
        creator = np.median([r["stats"]["creator"] / months for r in res])
        proto = np.median([r["stats"]["protocol"] / months for r in res])
        yld = np.median([r["stats"]["yield_paid"] / months for r in res])
        insolvent = sum(r["stats"]["insolvent"] for r in res)
        roy = np.median([r["stats"]["royalty"] / max(1.0, r["stats"]["spins"] * P) for r in res])
        recyc = np.median([r["stats"]["recycled_draws"] / max(1, r["stats"]["spins"]) for r in res])
        lp_take = np.median([(r["nav_end"] - sc.lp_capital) / max(1.0, r["stats"]["spins"] * P) for r in res])
        served = np.median([r["stats"]["spins"] / r["stats"]["requested"] for r in res])
        degraded = np.median([r["stats"]["degraded"] / max(1, r["stats"]["spins"]) for r in res])
        share = np.median([r["stats"]["yield_paid"] / max(1.0, r["stats"]["spins"] * P) for r in res])
        assert sum(r["stats"]["rtp_miss"] for r in res) == 0, "RTP lock failed"
        summary.append(
            f"| {sc.name} | ${flow:,.0f} | {fmt_pct(served)} | {fmt_pct(degraded)} | {fmt_pct(rtp)} | {fmt_pct(share, 2)} | {fmt_pct(roy, 2)} | {fmt_pct(recyc, 0)} | {fmt_pct(lp_take)} | {nav_cell} "
            f"| {dd_cell} | ${creator:,.0f} | ${proto:,.0f} | ${yld:,.0f} | {insolvent} |")

        rows = [f"**{sc.name}**", "",
                "| Tier | Sold per path | Days to sale (median / P90) | Ask / reference | Yield / ask | APR while waiting (median day) | Seller take / reference (median / P10) | Listed at end |",
                "|---|---|---|---|---|---|---|---|"]
        for k, name in enumerate(TIER_NAMES):
            sold = [x for r in res for x in r["stats"]["sold"][k]]
            if not sold:
                rows.append(f"| {name} | 0 | — | — | — | — | — | {np.median([r['listed_end'][k] for r in res]):.0f} |")
                continue
            a = np.array(sold)
            rows.append(
                f"| {name} | {len(sold) / runs:,.0f} | {np.median(a[:, 0]):.1f} / {np.percentile(a[:, 0], 90):.1f} "
                f"| {fmt_pct(np.mean(a[:, 1]))} | {fmt_pct(np.mean(a[:, 2]), 2)} "
                f"| {fmt_pct(np.median([np.median(r['stats']['apr_days'][k]) for r in res if r['stats']['apr_days'][k]]), 0)} "
                f"| {fmt_pct(np.median(a[:, 3]))} / {fmt_pct(np.percentile(a[:, 3], 10))} "
                f"| {np.median([r['listed_end'][k] for r in res]):.0f} |")
        rows.append("")
        seller_tables.extend(rows)
    out += summary + ["", "### Seller view (third-party consignments only)", ""] + seller_tables
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=30)
    args = ap.parse_args()
    lines = ["# Podmatic v2 simulation results", "",
             "Generated by `python3 sim/podmatic_sim.py --runs %d`. Assumptions are in the script's docstring." % args.runs, ""]
    lines += report_presets()
    lines += report_sim(args.runs)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
