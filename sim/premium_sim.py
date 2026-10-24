#!/usr/bin/env python3
"""非同质系列 NFT（如 SMB 这类按特征定价的 PFP 系列）的溢价定价对照。

一个系列里每个 NFT 都不同：真实价值 = 地板价 × 溢价倍数，倍数从 1 倍到几十倍。
比较三种让 NFT 进入抽卡机器的定价方式：

  A. 估值预言机上限：外部特征估值模型给出估值，挂价不超过估值的 105%（行业常见做法）。
  B. 只按地板价：所有 NFT 都按集合地板价收购（集合买单 / 地板池的做法）。
  C. 卖家自担保：卖家自报挂价；抽中者 72 小时内可按挂价的 x 倍退回，退回时这笔成交作废，
     NFT 回到卖家，卖家付挂价 3% 的退回费。（反例：验证“只靠卖家自担保”行不行）
  D. 承诺买单估值：NFT 的估值 = 对它有效的最高承诺买单（集合地板买单或特征买单），
     卖家只给底价；底价 ≤ 估值 × (1 + u) 才进入机器，按估值 × (1 + u) 结算；
     抽中者随时可以把 NFT 卖给定义估值的那笔买单。

衡量：
  - 上架率：持有人愿意把 NFT 放进机器的比例（按稀有度分层）
  - 卖家到手 ÷ 真实价值（只算最终成交的）
  - 玩家实得 ÷ 展示估值：决定展示的返还率是否可信
  - 退回率

模型：
  - 稀有度分层：近地板（1–1.3 倍，70%）、中档（1.3–3 倍，22%）、稀有（3–10 倍，6%）、
    极稀有（10–40 倍，2%）。
  - 变现折扣：越稀有越难卖。玩家按真实价值能马上变现的比例依次为 97% / 90% / 82% / 72%。
  - 外部估值模型的误差随稀有度变大：8% / 20% / 35% / 50%（对数标准差）。
  - 持有人对自己 NFT 的估计误差 10%；心理底价中位数比真实价值高 5%。
  - 抽中者对可变现价值的判断误差 15%。
  - 承诺买单：近地板 NFT 的估值就是地板买单（地板价的 98%）。其他 NFT 有一定概率存在
    覆盖它的特征买单（90% / 70% / 40%），买单价格为真实价值的 80–95% / 70–90% / 55–85%；
    没有特征买单时只能按地板买单估值。

用法：
  python3 sim/premium_sim.py > sim/premium_results.md
"""

import math

import numpy as np

N = 200_000  # 候选持有人数
CLASSES = [
    # 名称, 占比, 倍数下限, 倍数上限, 变现折扣, 估值模型误差
    ("近地板 1–1.3 倍", 0.70, 1.0, 1.3, 0.97, 0.08),
    ("中档 1.3–3 倍", 0.22, 1.3, 3.0, 0.90, 0.20),
    ("稀有 3–10 倍", 0.06, 3.0, 10.0, 0.82, 0.35),
    ("极稀有 10–40 倍", 0.02, 10.0, 40.0, 0.72, 0.50),
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
    m = mult  # 以地板价为 1 计价
    r = m * np.exp(rng.normal(RESERVE_MU, RESERVE_SD, N))
    m_hat = m * np.exp(rng.normal(0, SELLER_SD, N))
    oracle = m * np.exp(rng.normal(0, osd))
    winner = m * liq * np.exp(rng.normal(0, WINNER_SD, N))  # 抽中者认为自己能变现的价值
    return dict(cls=cls, m=m, liq=liq, r=r, m_hat=m_hat, oracle=oracle, winner=winner)


def summarize(name, pop, listed, ask, value_to_player, seller_get, sold, returned):
    rows = []
    for k, c in enumerate(CLASSES + [("全部", 1, 0, 0, 0, 0)]):
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
    return summarize("A. 估值预言机上限", pop, listed, ask, pop["m"], ask, sold, zero)


def mech_floor(pop):
    ask = np.full(N, FLOOR_BID)
    listed = pop["r"] <= ask
    zero = np.zeros(N, dtype=bool)
    return summarize("B. 只按地板价", pop, listed, ask, pop["m"], ask, listed, zero)


def mech_guarantee(pop, x_by_class):
    """卖家在自己的信息下选择挂价，使期望收益最大；抽中者按真实判断决定是否退回。"""
    x = np.array(x_by_class)[pop["cls"]]
    grid = np.linspace(0.8, 2.0, 61)
    best_u = np.full(N, -np.inf)
    best_a = np.zeros(N)
    # 卖家对抽中者判断的预期：中位数 = 自己的估计 × 变现折扣，误差合成两边的不确定
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
    # 玩家实得：保留则得到 NFT（真实价值），退回则拿到 x × 挂价现金
    value = np.where(returned, x * ask, pop["m"])
    seller_get = np.where(sold, ask, 0.0)
    label = "C. 卖家自担保（退回比例 " + " / ".join(f"{v:.0%}" for v in x_by_class) + "）"
    return summarize(label, pop, listed, ask, value, seller_get, sold, returned)


BID_COVER = [1.0, 0.90, 0.70, 0.40]
BID_RANGE = [(0.98, 0.98), (0.80, 0.95), (0.70, 0.90), (0.55, 0.85)]


# 买单市场成熟后：特征买单覆盖更广、出价更接近真实价值
BID_COVER_MATURE = [1.0, 0.97, 0.90, 0.70]
BID_RANGE_MATURE = [(0.98, 0.98), (0.88, 0.98), (0.82, 0.95), (0.70, 0.92)]


def mech_committed_bids(pop, rng, u, cover_by_class=BID_COVER, range_by_class=BID_RANGE, label="早期"):
    """估值来自承诺买单，卖家只给底价。"""
    cls = pop["cls"]
    cover = rng.random(N) < np.array(cover_by_class)[cls]
    lo = np.array([b[0] for b in range_by_class])[cls]
    hi = np.array([b[1] for b in range_by_class])[cls]
    trait_bid = pop["m"] * rng.uniform(lo, hi)
    g = np.where(cover, np.maximum(trait_bid, FLOOR_BID), FLOOR_BID)
    price = g * (1 + u)
    listed = pop["r"] <= price
    # 抽中者：外部能卖得比买单高就留着，否则卖给买单
    value = np.maximum(pop["m"] * pop["liq"], g)
    zero = np.zeros(N, dtype=bool)
    # 展示估值按可兑现的买单价 g 计
    return summarize(f"D. 承诺买单估值，{label}买单市场（结算溢价 u = {u:.0%}）", pop, listed, g, value, price, listed, zero)


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
                            BID_COVER_MATURE, BID_RANGE_MATURE, "成熟"),
    ]
    out = ["# 系列 NFT 溢价定价对照", "",
           "由 `python3 sim/premium_sim.py` 生成。假设见脚本顶部文档字符串。", ""]
    for name, rows in results:
        out += [f"### {name}", "",
                "| 稀有度 | 上架率 | 卖家到手 ÷ 真实价值 | 玩家实得 ÷ 展示估值 | 退回率 |",
                "|---|---|---|---|---|"]
        for r in rows:
            out.append(f"| {r['cls']} | {pct(r['list_rate'])} | {pct(r['seller_ratio'])} "
                       f"| {pct(r['player_ratio'])} | {pct(r['return_rate'])} |")
        out.append("")
    # 卖家自担保对退回罚金的敏感性
    global PENALTY
    out += ["### C 的罚金敏感性（全部 NFT）", "",
            "| 退回罚金 | 退回比例 | 上架率 | 卖家到手 ÷ 真实价值 | 玩家实得 ÷ 展示估值 | 退回率 |",
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
