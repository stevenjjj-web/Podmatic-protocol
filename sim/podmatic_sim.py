#!/usr/bin/env python3
"""Podmatic v2 经济模拟。

两部分：
  1. presets  —— 三套概率预设的解析统计（返还率、回本率、波动）。
  2. simulate —— 单台机器的蒙特卡洛模拟：挂卡人陆续挂卡、玩家抽卡、
     卖回 / 以卡换抽 / 持有、库存收益按天分配、金库LP承担储备。

用法：
  python3 sim/podmatic_sim.py              # 全部场景，输出 Markdown 到 stdout
  python3 sim/podmatic_sim.py --runs 10    # 更少的随机路径，跑得更快

模型假设（全部可在 Scenario / 常量里改）：
  - 卡牌参考价在档位区间内按对数均匀分布；参考价即市场价，预言机无误差。
  - 档位按参考价划分，玩家返还率按参考价计，向挂卡人结算按挂价。
  - 挂卡人报价风格：30% 急售(0.92-0.97)，50% 平价(0.98-1.02)，20% 惜售(1.03-1.05)。
  - 玩家抽中后：35% 卖回现金(88%)，25% 以卡换抽(95%)，40% 持有。
  - 有抽卡额度时优先用额度抽卡。
  - 金库持有的回收卡按参考价重新上架，不领库存收益，净值按参考价 85% 计。
"""

import argparse
import math
from dataclasses import dataclass, field

import numpy as np

P = 50.0  # 示例机器单抽价（美元）
TIER_NAMES = ["普通", "罕见", "稀有", "史诗", "传说"]
# 档位区间：单抽价的倍数（协议标准档位）
BANDS = [(0.2, 0.6), (0.6, 1.5), (1.5, 4.0), (4.0, 12.0), (12.0, 60.0)]

# 每抽资金瀑布（占单抽价比例）
FEE_PROTOCOL = 0.015
FEE_CREATOR = 0.025
FEE_FRONTEND = 0.01
FEE_INVENTORY = 0.02  # 库存收益池：每抽固定拨入，不够时由储备补足
INV_CAP = 0.06  # 库存收益总支出上限：当天流水的 6%
# 库存收益率曲线：按档位“库存覆盖天数”定年化。覆盖天数 = 在架寄售价值 / 该档日均期望出货价值
CURVE_D_LO, CURVE_D_HI = 3.0, 30.0  # 覆盖不足 3 天给最高年化，超过 30 天给最低年化
APR_MAX, APR_MIN = 1.00, 0.08
FEE_PITY = 0.01  # 保底池
TO_RESERVE = 1.0 - FEE_PROTOCOL - FEE_CREATOR - FEE_FRONTEND - FEE_INVENTORY - FEE_PITY

SELLBACK_RATE = 0.88
TRADEIN_RATE = 0.95
P_SELLBACK = 0.35
P_TRADEIN = 0.25
WEIGHT_EXP = 3.0  # 档内权重 (V/a)^3
ASK_CAP = 1.05  # 挂价上限：参考价 105%
PAUSE_AT = 1.15  # 挂价超过参考价 115% 自动暂停
VAULT_MARK = 0.85  # 回收卡净值计价
SELLBACK_BUFFER = 20  # 储备低于 20 倍单抽价时，现金卖回自动改为以卡换抽
RTP_FLOOR = 0.85  # 协议返还率下限
ROYALTY = 0.02  # 流通分成：回收卡每次被再次抽中，按参考价 2% 付给最初的寄售人

# 非普通档的相对形状；普通档概率由校准求出
SHAPES = {
    "稳健": [22.0, 7.5, 2.2, 0.30],
    "标准": [18.0, 7.0, 2.7, 0.25],
    "追梦": [12.0, 5.0, 2.0, 0.70],
}


def band_mean(lo, hi):
    return (hi - lo) / math.log(hi / lo)


def band_second_moment(lo, hi):
    return (hi * hi - lo * lo) / (2.0 * math.log(hi / lo))


def band_tail(lo, hi, x):
    """对数均匀分布下 V >= x 的概率。"""
    if x <= lo:
        return 1.0
    if x >= hi:
        return 0.0
    return math.log(hi / x) / math.log(hi / lo)


TIER_MEANS = [band_mean(lo, hi) for lo, hi in BANDS]


def calibrate(shape, rtp):
    """缩放非普通档概率，使期望价值（单抽价倍数）恰好等于 rtp。"""
    q = np.array(shape) / 100.0
    m = np.array(TIER_MEANS)
    s = (rtp - m[0]) / float(np.sum(q * (m[1:] - m[0])))
    probs = np.concatenate([[1.0 - s * q.sum()], s * q])
    assert probs.min() > 0, "形状与目标返还率不兼容"
    return probs


def preset_stats(probs):
    ev = sum(p * m for p, m in zip(probs, TIER_MEANS))
    ev2 = sum(p * band_second_moment(lo, hi) for p, (lo, hi) in zip(probs, BANDS))
    sd = math.sqrt(ev2 - ev * ev)

    def tail(x):
        return sum(p * band_tail(lo, hi, x) for p, (lo, hi) in zip(probs, BANDS))

    return dict(ev=ev, sd=sd, hit1=tail(1.0), hit5=tail(5.0), hit20=tail(20.0))


def pity_cost(probs, threshold, session_len):
    """保底的期望成本（占单抽价比例）。

    一个钱包连续抽 session_len 次；连续 threshold 抽未出稀有及以上时，
    下一抽只在稀有及以上档里抽，超出普通期望值的部分由保底池支付。
    """
    p_hit = float(sum(probs[2:]))
    ev_all = sum(p * m for p, m in zip(probs, TIER_MEANS))
    ev_rare = sum(p * m for p, m in zip(probs[2:], TIER_MEANS[2:])) / p_hit
    extra = ev_rare - ev_all
    # 动态规划：状态 = 当前连续未中数
    dist = np.zeros(threshold + 1)
    dist[0] = 1.0
    triggers = 0.0
    for _ in range(session_len):
        new = np.zeros_like(dist)
        triggers += dist[threshold]
        new[0] += dist[threshold]  # 保底抽必中
        new[0] += dist[:threshold].sum() * p_hit
        new[1:threshold + 1] += dist[:threshold] * (1 - p_hit)
        dist = new
    return triggers * extra / session_len


# --------------------------------------------------------------------------
# 蒙特卡洛
# --------------------------------------------------------------------------


@dataclass
class Scenario:
    name: str
    spins_per_day: int
    lp_capital: float
    supply_mult: float = 1.0  # 第三方挂卡到达率倍数
    drift: float = 0.0  # 模拟期内卡价对数漂移，-0.29 约等于下跌 25%
    days: int = 90
    risk: float = 0.25
    preset: str = "标准"
    rtp: float = 0.89  # 抽取部分的返还率（按参考价），不含保底池
    creator_seeded: bool = False  # 储备全部来自主理人的种子资金，没有外部LP


class TierBook:
    """一个档位的在架卡。V0 为基准指数下的参考价，实时参考价 = V0 * 指数。"""

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
        """返回 (可抽权重, 档内期望参考价)；无可抽卡时返回 (None, 0)。

        可抽 = 未暂停，且（金库卡 或 挂价 <= 水位门槛）。
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
    """库存收益率曲线：供给越薄，年化越高。"""
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
    arrival = sc.supply_mult * 0.5 * n * base  # 第三方挂卡到达率（张/天）

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

        # 1) 按实时参考价重新分档；超出机器区间的卡下架（金库卡按 90% 市价卖出）
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

        # 2) 挂卡人：超出耐心撤单；被暂停的挂单按 30%/天 的概率下调到参考价
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

        # 3) 新挂卡（当天开始时到达）
        for k in range(nt):
            for _ in range(rng.poisson(arrival[k])):
                new_listing(k, day, idx)

        inv_pool = 0.0
        day_flow = 0.0

        # 4) 当天的抽卡
        for j in range(n):
            t = day + j / n
            stats["requested"] += 1
            # 有额度先用额度（额度抽卡的费用由储备付现金）
            use_credit = credit >= P and reserve >= (1.0 - TO_RESERVE) * P
            inflow = -(1.0 - TO_RESERVE) * P if use_credit else TO_RESERVE * P
            # 水位只看现金：额度只能用来抽卡，抽中的奖品仍受水位约束
            threshold = risk * (reserve + inflow)
            evals = [b.evaluate(idx, threshold) for b in books]
            live = np.array([e[0] is not None for e in evals])
            ev = np.array([e[1] for e in evals])
            # 开机条件：至少两档有货；最低档期望不高于目标，最高档期望不低于返还率下限。
            # 水位不足以达到目标时，本抽返还率降到最高可达值（不低于下限），前端实时展示。
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
                amt = SELLBACK_RATE * cost_basis
                # 卖回缓冲：现金卖回后储备仍需不低于 SELLBACK_BUFFER 抽，否则改为以卡换抽
                if reserve - amt >= SELLBACK_BUFFER * P:
                    reserve -= amt
                else:
                    credit += TRADEIN_RATE * cost_basis
                books[k].add(v0, v, False, t, 1e9)
            elif u < P_SELLBACK + P_TRADEIN:
                credit += TRADEIN_RATE * cost_basis
                books[k].add(v0, v, False, t, 1e9)

        # 5) 库存收益：各档按覆盖天数定年化，按参考价分给在架的第三方寄售卡。
        #    先用收益池，不够由储备补足；总额不超过当天流水的 INV_CAP；池子剩余回流储备。
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
    Scenario("基准：日均400抽，LP 2万", 400, 20000),
    Scenario("冷启动A：日均100抽，种子储备$500(10倍单抽)，风险系数1.0", 100, 500, risk=1.0, creator_seeded=True),
    Scenario("冷启动B：日均100抽，种子储备$2,000(40倍单抽)，风险系数1.0", 100, 2000, risk=1.0, creator_seeded=True),
    Scenario("冷启动C：日均100抽，种子储备$5,000(100倍单抽)，风险系数0.1", 100, 5000, risk=0.1, creator_seeded=True),
    Scenario("小机器：日均100抽，LP 1万", 100, 10000),
    Scenario("大机器：日均1500抽，LP 5万", 1500, 50000),
    Scenario("供给不足：挂卡到达率减半", 400, 20000, supply_mult=0.5),
    Scenario("熊市：90天卡价下跌25%", 400, 20000, drift=math.log(0.75)),
    Scenario("竞争后：抽取返还率提到93%", 400, 20000, rtp=0.93),
]


def fmt_pct(x, digits=1):
    return f"{x * 100:.{digits}f}%"


def report_presets():
    out = ["## 一、概率预设（单抽50美元，抽取返还率89%，按参考价）", ""]
    out.append("| 预设 | 普通 | 罕见 | 稀有 | 史诗 | 传说 | 返还率 | 回本率(≥1倍) | ≥5倍 | ≥20倍 | 单抽标准差 | 保底成本(阈值40/会话50抽) |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, shape in SHAPES.items():
        probs = calibrate(shape, 0.89)
        s = preset_stats(probs)
        pc = pity_cost(probs, 40, 50)
        cells = " | ".join(fmt_pct(p, 2) for p in probs)
        out.append(
            f"| {name} | {cells} | {fmt_pct(s['ev'])} | {fmt_pct(s['hit1'])} | {fmt_pct(s['hit5'], 2)} "
            f"| {fmt_pct(s['hit20'], 2)} | {s['sd']:.2f}倍 | {fmt_pct(pc, 2)} |")
    out.append("")
    out.append("保底阈值敏感性（标准预设）：")
    out.append("")
    out.append("| 阈值 | 会话20抽 | 会话50抽 | 会话200抽 |")
    out.append("|---|---|---|---|")
    probs = calibrate(SHAPES["标准"], 0.89)
    for th in (20, 30, 40, 50):
        row = " | ".join(fmt_pct(pity_cost(probs, th, sl), 2) for sl in (20, 50, 200))
        out.append(f"| {th} | {row} |")
    out.append("")
    return out


def report_sim(runs):
    out = [f"## 二、单机蒙特卡洛（每个场景 {runs} 条路径，90天，标准预设）", ""]
    summary = ["| 场景 | 月流水 | 需求满足率 | 降档抽占比 | 玩家抽取返还率 | 库存收益/流水 | 流通分成/流水 | 回收卡占出货 | LP收益/流水 | LP净值90天变化(中位/最差) | 最大回撤(中位/最差) | 主理人月收入 | 协议月收入 | 挂卡人月库存收益 | 偿付失败 |",
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
            nav_cell = f"种子储备净值 {usd(np.median(nav))} / {usd(np.min(nav))}"
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
        assert sum(r["stats"]["rtp_miss"] for r in res) == 0, "返还率锁定失败"
        summary.append(
            f"| {sc.name} | ${flow:,.0f} | {fmt_pct(served)} | {fmt_pct(degraded)} | {fmt_pct(rtp)} | {fmt_pct(share, 2)} | {fmt_pct(roy, 2)} | {fmt_pct(recyc, 0)} | {fmt_pct(lp_take)} | {nav_cell} "
            f"| {dd_cell} | ${creator:,.0f} | ${proto:,.0f} | ${yld:,.0f} | {insolvent} |")

        rows = [f"**{sc.name}**", "",
                "| 档位 | 售出张数/路径 | 成交等待天数(中位/P90) | 挂价/参考价 | 库存收益/挂价 | 等待期年化(中位天) | 挂卡人到手/参考价(中位/P10) | 期末在架 |",
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
    out += summary + ["", "### 挂卡人视角（只统计第三方寄售卡）", ""] + seller_tables
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=30)
    args = ap.parse_args()
    lines = ["# Podmatic v2 模拟结果", "",
             "由 `python3 sim/podmatic_sim.py --runs %d` 生成。假设见脚本顶部文档字符串。" % args.runs, ""]
    lines += report_presets()
    lines += report_sim(args.runs)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
