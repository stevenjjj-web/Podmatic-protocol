#!/usr/bin/env python3
"""Podmatic 定价机制对照模拟：卖家挂价 + 预言机上限（v2） vs 型号曲线定价（v3）。

同一组市场条件下，两种机制各跑一遍，比较：
  - 估值准确度：玩家拿到的卡的真实市价 ÷ 协议给它的估值（决定玩家真实返还率）
  - 结算溢价：协议付给卖家的钱 ÷ 卡的真实市价
  - 金库成本：金库为交付每 1 美元真实价值付出的净现金
  - 价格跟踪误差：协议价格与真实市价的偏离

市场模型：
  - 一个档位（50 美元机的“稀有”档）里有 K 个卡牌型号（卡牌 × 评级机构 × 分数），
    同型号的卡在经济上可以互换。
  - 每个型号有一个看不见的真实市价 M，按日随机游走并偶有跳变。
  - 外部预言机 O = 7 天前的 M × 持续性误差（标准差约 10%），模拟 PriceCharting 一类数据源。
  - 普通持有人陆续到达，心理底价 r 中位数比市价高 5%（惜售）。
  - 套利者可以在外部市场按 M ± 摩擦成本买卖同型号的卡。
  - 抽卡是随机的不知情买盘；玩家抽中后，只在卖回价不低于外部净价时才卖回（知情）。

用法：
  python3 sim/pricing_sim.py --runs 20 > sim/pricing_results.md
"""

import argparse
import math
from bisect import insort

import numpy as np

K = 150  # 型号数
DAYS = 180
DRAWS_PER_DAY = 80
HOLDERS_PER_DAY = 60
LO, HI = 75.0, 200.0  # 档位区间（美元）
VOL = 0.015  # 真实市价日波动
JUMP_P, JUMP_SD = 0.005, 0.20  # 跳变
ORACLE_LAG = 7
ORACLE_SD, ORACLE_RHO = 0.10, 0.97
ARB_COST = 0.015  # 套利者在外部市场买卖的摩擦成本
PLAYER_EXIT = 0.97  # 玩家在外部卖卡的净得比例
PATIENCE = 60

# v2：挂价 + 预言机上限
ASK_CAP = 1.05
WEIGHT_EXP = 3.0

# v3：型号曲线
FEE = 0.02  # 买卖价差的一半：bid = P(1-FEE)，ask = P(1+FEE)
DELTA = 0.02  # 每进出一张，价格移动 2%
DRIFT_UP = 0.01  # 无货时每天上调 1%
DRIFT_DOWN = 0.005  # 库存超过目标时每天下调 0.5%
TARGET_UNITS = 6
TWAP_DAYS = 3  # 结算用的时间加权价格窗口
ARB_MAX = 20  # 每个型号每天最多套利张数


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
    # 金库净成本 = 净现金流出 − 期末库存按真实市价
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
    """v2：挂价 ≤ 105% × 预言机；估值用预言机；按挂价结算；回购 88%。"""
    rng = np.random.default_rng(seed)
    mk = Market(rng)
    listings = [[] for _ in range(K)]  # (ask, t, kind)；kind: 0 持有人, 1 套利者, 2 金库
    honest = {}  # 持有人挂单 -> 挂单时底价是否不高于市价
    st = new_stats()
    for day in range(DAYS):
        mk.step()
        o = mk.oracle
        cap = ASK_CAP * o
        # 撤掉超时或超过上限的持有人挂单
        for j in range(K):
            listings[j] = [x for x in listings[j]
                           if not (x[2] == 0 and (day - x[1] > PATIENCE or x[0] > 1.15 * o[j]))]
        # 持有人：底价低于上限才挂，挂价取底价与上限之间
        for _ in range(rng.poisson(HOLDERS_PER_DAY)):
            j = rng.integers(K)
            r = holder_reservation(rng, mk.m[j])
            if r <= cap[j]:
                ask = min(cap[j], max(r, o[j] * rng.uniform(0.98, 1.05)))
                listings[j].append((ask, day, 0))
                honest[(j, day, ask)] = r <= mk.m[j]
        # 套利者：上限高于外部买入成本时，从外部买卡挂进来
        for j in range(K):
            if cap[j] > mk.m[j] * (1 + ARB_COST):
                n_arb = sum(1 for x in listings[j] if x[2] == 1)
                for _ in range(max(0, 3 - n_arb)):
                    listings[j].append((cap[j], day, 1))
                    st["arb_in"] += 1
        # 抽卡
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
            # 玩家：卖回价不低于外部净价才卖回
            back = 0.88 * min(ask, o[j])
            if back >= PLAYER_EXIT * mk.m[j]:
                st["vault_cash"] += back
                listings[j].append((o[j], day, 2))
    vault_value = sum(mk.m[j] for j in range(K) for x in listings[j] if x[2] == 2)
    return finish(st, vault_value)


def run_curve_model(seed):
    """v3：每个型号一条价格曲线；进一张降 2%，出一张升 2%；持有人只设底价。"""
    rng = np.random.default_rng(seed)
    mk = Market(rng)
    p = mk.oracle.copy()  # 冷启动用带误差的预言机做初始价
    p_hist = [p.copy()]
    floors = [[] for _ in range(K)]  # 持有人寄售：(t, floor, 底价是否不高于市价)，按时间先后排队
    vault = np.zeros(K, dtype=int)  # 金库自有库存
    st = new_stats()

    def in_range(j):
        return [x for x in floors[j] if x[1] <= p[j]]

    for day in range(DAYS):
        mk.step()
        twap = np.mean(p_hist[-TWAP_DAYS:], axis=0)
        for j in range(K):
            floors[j] = [x for x in floors[j] if day - x[0] <= PATIENCE]
        # 持有人只给底价；底价高于当前价格时不在区间内，不会被抽中
        for _ in range(rng.poisson(HOLDERS_PER_DAY)):
            j = rng.integers(K)
            r = holder_reservation(rng, mk.m[j])
            floors[j].append((day, r, r <= mk.m[j]))
        # 套利：价格偏离外部市场超过价差＋摩擦时双向套利
        for j in range(K):
            for _ in range(ARB_MAX):
                if p[j] * (1 - FEE) > mk.m[j] * (1 + ARB_COST):
                    st["vault_cash"] += p[j] * (1 - FEE)
                    vault[j] += 1
                    p[j] *= 1 - DELTA
                    st["arb_in"] += 1
                elif p[j] * (1 + FEE) < mk.m[j] * (1 - ARB_COST) and vault[j]:
                    # 直购只卖金库自有库存：寄售卡只面对随机抽卡，不会被套利者挑走
                    st["vault_cash"] -= p[j] * (1 + FEE)
                    vault[j] -= 1
                    p[j] *= 1 + DELTA
                    st["arb_out"] += 1
                else:
                    break
        # 时间漂移：无货就涨，库存过多就跌
        for j in range(K):
            n = vault[j] + len(in_range(j))
            if n == 0:
                p[j] *= 1 + DRIFT_UP
            elif n > TARGET_UNITS:
                p[j] *= 1 - DRIFT_DOWN
        # 抽卡：在所有在区间内的卡里均匀抽
        for _ in range(DRAWS_PER_DAY):
            counts = np.array([vault[j] + len(in_range(j)) for j in range(K)], dtype=float)
            if counts.sum() == 0:
                continue
            j = int(rng.choice(K, p=counts / counts.sum()))
            value = min(p[j], twap[j]) * (1 - FEE)  # 估值取即时价与 TWAP 的较低者，再按买入价计
            settle = twap[j]  # 寄售人按 TWAP 结算，单笔拉盘影响不到结算价
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
            # 玩家：按买入价卖回不低于外部净价才卖回
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
    rows = {"v2 挂价＋预言机上限": run_ask_model, "v3 型号曲线定价": run_curve_model}
    out = ["# 定价机制对照模拟", "",
           f"由 `python3 sim/pricing_sim.py --runs {args.runs}` 生成。假设见脚本顶部文档字符串。",
           f"一个档位、{K} 个型号、{DAYS} 天、日均 {DRAWS_PER_DAY} 抽；每个机制 {args.runs} 条路径，表中为中位数（括号内为最差路径）。", "",
           "| 机制 | 估值准确度（真实价值÷估值） | 结算溢价（付给卖家÷真实价值） | 金库每交付 1 美元真实价值的净成本 | 估值偏差中位/P90 | 持有人成交数 | 其中底价≤市价的占比 | 等待天数中位：底价≤市价 / 底价>市价 | 套利卖入/买出 |",
           "|---|---|---|---|---|---|---|---|---|"]
    for name, fn in rows.items():
        res = [fn(1000 + r) for r in range(args.runs)]
        acc = [r["accuracy"] for r in res]
        prem = [r["seller_premium"] for r in res]
        cost = [r["vault_cost"] for r in res]
        out.append(
            f"| {name} | {pct(np.median(acc))}（{pct(min(acc))}） | {pct(np.median(prem))}（{pct(max(prem))}） "
            f"| ${np.median(cost):.3f}（${max(cost):.3f}） | {pct(np.median([r['track'] for r in res]))} / "
            f"{pct(np.median([r['track90'] for r in res]))} | {np.median([r['fills'] for r in res]):,.0f} "
            f"| {pct(np.median([r['share_honest'] for r in res]), 0)} "
            f"| {np.median([r['wait_honest'] for r in res]):.1f} / {np.median([r['wait_greedy'] for r in res]):.1f} "
            f"| {np.median([r['arb_in'] for r in res]):,.0f} / "
            f"{np.median([r['arb_out'] for r in res]):,.0f} |")
    print("\n".join(out))


if __name__ == "__main__":
    main()
