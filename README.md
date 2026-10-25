# Podmatic Protocol

收藏品的做市协议：抽卡是成交，挂卡是做市。

任何人都能开一台链上抽卡机器，任何持有托管卡 NFT 的人都能把卡挂进机器做市，任何人都能为机器提供储备。

## 文档

- [`docs/podmatic-pricing.md`](docs/podmatic-pricing.md)：定价架构。NFT 价值拆成地板、特征溢价、个体溢价三部分：地板用价格曲线和套利定价，特征溢价用锁定资金的特征买单定价，定不了价的稀有品走透明单品抽；卖家只给底价。取代 v2 的“挂价 + 预言机上限”。
- [`docs/podmatic-liquidity.md`](docs/podmatic-liquidity.md)：Tensor 的流动性设计研究，以及用抽卡流量为 NFT 做市的五个机制：开放地板做市订单、共享担保金的特征买单、概率买单、只用真实流水做激励、项目方参与。
- [`docs/podmatic-v2-design.md`](docs/podmatic-v2-design.md)：v2 产品与经济设计，包括挂卡人激励、概率与单价、主理人权限、冷启动修订、可行性判断。
- v1《卡池协议：抽卡池的Uniswap化》（2026-10-23）是 v2 的基础，不在本仓库中。

## 模拟

```bash
pip install numpy
python3 sim/podmatic_sim.py --runs 30 > sim/results.md
```

- [`sim/podmatic_sim.py`](sim/podmatic_sim.py)：概率预设的解析统计，以及单台机器 90 天的蒙特卡洛模拟。模拟覆盖挂卡、抽卡、卖回和换抽、库存收益、流通分成、水位解锁和返还率锁定。
- [`sim/results.md`](sim/results.md)：最近一次运行的输出，v2 文档中的数字都来自这里。
- [`sim/premium_sim.py`](sim/premium_sim.py)：系列 NFT 的四种定价方式对照（估值预言机、只按地板、卖家自担保、承诺买单），运行 `python3 sim/premium_sim.py > sim/premium_results.md`。
- [`sim/premium_results.md`](sim/premium_results.md)：系列 NFT 定价对照的输出。
- [`sim/mm_sim.py`](sim/mm_sim.py)：Tensor 式地板做市订单在有无抽卡流量下的收益对照，运行 `python3 sim/mm_sim.py > sim/mm_results.md`。
- [`sim/mm_results.md`](sim/mm_results.md)：做市对照的输出。
- [`sim/pricing_sim.py`](sim/pricing_sim.py)：可互换资产（系列地板、评级卡型号）的价格曲线与“挂价 + 预言机上限”对照，运行 `python3 sim/pricing_sim.py --runs 20 > sim/pricing_results.md`。
- [`sim/pricing_results.md`](sim/pricing_results.md)：价格曲线对照的输出。

模型假设写在脚本顶部的文档字符串里。
