#!/usr/bin/env python3
"""NFT 地板做市订单的收益：只有知情套利流量 vs 加入抽卡带来的不知情流量。

做市订单的设定参照 Tensor 的双边做市订单：
  - 卖价 S；买价 B = S / (1 + δ) × (1 − 价差费)
  - 有人从订单买走一个 NFT：S ← S × (1 + δ)；有人卖进一个：S ← S / (1 + δ)
外部地板价 M 按小时随机游走。流量有两类：
  - 知情套利：订单卖价低于外部地板（扣摩擦成本）就买走，买价高于外部地板就卖进来
  - 不知情流量：抽卡机器从订单买地板款（随机到达），玩家把抽到的地板款卖回订单
    （到达率为买入的一半）。抽卡买卖不看外部价格。

衡量：90 天后做市订单的价值 − 一直持有初始资产的价值，占初始资产的比例。
一律以期末外部地板价计价。

用法：
  python3 sim/mm_sim.py > sim/mm_results.md
"""

import numpy as np

HOURS = 90 * 24
VOL_DAILY = 0.04  # NFT 系列地板价日波动
DELTA = 0.03
FEE = 0.04  # 做市价差费
ARB_COST = 0.02  # 套利者在外部市场的成本（外部手续费、版税、滑点）
CASH0 = 10.0  # 以地板价计的初始现金
NFTS0 = 10
RUNS = 300


def run(rng, draws_per_day, fee=FEE, delta=DELTA):
    m = 1.0
    s = 1.0 * (1 + delta)  # 初始卖价略高于地板
    cash, nfts = CASH0, NFTS0
    vol = VOL_DAILY / np.sqrt(24)
    lam_buy = draws_per_day / 24
    lam_sell = lam_buy / 2
    fees = 0.0
    for _ in range(HOURS):
        m *= np.exp(rng.normal(0, vol))
        # 不知情流量
        for _ in range(rng.poisson(lam_buy)):
            if nfts > 0:
                cash += s
                nfts -= 1
                s *= 1 + delta
        for _ in range(rng.poisson(lam_sell)):
            b = s / (1 + delta) * (1 - fee)
            if cash >= b:
                cash -= b
                nfts += 1
                fees += s / (1 + delta) * fee
                s /= 1 + delta
        # 知情套利
        while nfts > 0 and s < m * (1 - ARB_COST):
            cash += s
            nfts -= 1
            s *= 1 + delta
        while True:
            b = s / (1 + delta) * (1 - fee)
            if cash >= b and b > m * (1 + ARB_COST):
                cash -= b
                nfts += 1
                s /= 1 + delta
            else:
                break
    value = cash + nfts * m
    hold = CASH0 + NFTS0 * m
    initial = CASH0 + NFTS0 * 1.0
    return (value - hold) / initial


def main():
    rng = np.random.default_rng(3)
    out = ["# 地板做市订单收益：抽卡流量的作用", "",
           "由 `python3 sim/mm_sim.py` 生成。假设见脚本顶部文档字符串。",
           f"初始资产：{CASH0:.0f} 个地板价的现金 ＋ {NFTS0} 个地板款；δ = {DELTA:.0%}，价差费 = {FEE:.0%}，"
           f"地板日波动 {VOL_DAILY:.0%}，套利成本 {ARB_COST:.0%}，90 天，{RUNS} 条路径。", "",
           "| 每天抽卡从订单买走的地板款 | 相对持有的超额收益（中位） | P10 | P90 | 跑输持有的路径占比 |",
           "|---|---|---|---|---|"]
    for draws in (0, 1, 3, 6, 12):
        res = np.array([run(rng, draws) for _ in range(RUNS)])
        out.append(f"| {draws} | {np.median(res) * 100:+.1f}% | {np.percentile(res, 10) * 100:+.1f}% "
                   f"| {np.percentile(res, 90) * 100:+.1f}% | {np.mean(res < 0) * 100:.0f}% |")
    print("\n".join(out))


if __name__ == "__main__":
    main()
