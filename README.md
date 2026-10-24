# Podmatic Protocol

收藏品的做市协议：抽卡是成交，挂卡是做市。

任何人都能开一台链上抽卡机器，任何持有托管卡 NFT 的人都能把卡挂进机器做市，任何人都能为机器提供储备。

## 文档

- [`docs/podmatic-v2-design.md`](docs/podmatic-v2-design.md)：v2 产品与经济设计，包括挂卡人激励、概率与单价、主理人权限、冷启动修订、可行性判断。
- v1《卡池协议：抽卡池的Uniswap化》（2026-10-23）是 v2 的基础，不在本仓库中。

## 模拟

```bash
pip install numpy
python3 sim/podmatic_sim.py --runs 30 > sim/results.md
```

- [`sim/podmatic_sim.py`](sim/podmatic_sim.py)：概率预设的解析统计，以及单台机器 90 天的蒙特卡洛模拟。模拟覆盖挂卡、抽卡、卖回和换抽、库存收益、流通分成、水位解锁和返还率锁定。
- [`sim/results.md`](sim/results.md)：最近一次运行的输出，v2 文档中的数字都来自这里。

模型假设写在脚本顶部的文档字符串里。
