# Podmatic Protocol

收藏品的做市协议：抽卡是成交，挂卡是做市。

任何人都能开一台链上抽卡机器；NFT 持有人只给底价，把 NFT 挂进机器；每个 NFT 的估值来自真金白银锁定的买单，抽中者可以随时按估值卖给那笔买单；LP 为机器提供储备。部署目标为 **Ethereum** 和 **Base**（以及 Sepolia、Base Sepolia 测试网）。

> ⚠️ 合约未经审计。请只在本地和测试网使用。部署脚本默认拒绝主网，需显式设置 `ALLOW_MAINNET=1`。

## 快速开始（本地，一条命令）

需要 Node.js 20+。

```bash
npm run setup   # 安装 contracts 和 web 依赖
npm run dev     # 启动本地链 → 部署合约并填充演示数据 → 启动前端
```

打开 http://localhost:5173 ，点「连接钱包」→「本地测试钱包」。这是 Hardhat 节点的默认账户，不需要 MetaMask。演示数据包括：

- 200 个 Pod Apes 演示 NFT（特征快照已上链），你的钱包里有 40 个，以及 100 万测试 USDC（右上角可再领）；
- 8 笔已满 24 小时的集合与特征买单；
- 两台机器（标准机、追梦机），共 110 件寄售 NFT，LP 储备 10 万；
- 2 个地板做市订单、5 个概率买挂单。

本地用模拟随机数：抽卡后前端会自动再发一笔交易完成“VRF 回调”。测试网和主网用 Chainlink VRF v2.5。

## 目录

```
contracts/   Solidity 合约、测试、部署脚本（Hardhat）
web/         前端（Vite + React + wagmi/viem + RainbowKit）
docs/        设计文档
sim/         经济模拟（Python）
scripts/     dev.mjs：一键本地环境
```

## 设计 → 合约

| 设计（docs） | 合约 | 说明 |
|---|---|---|
| 特征快照 | `CollectionRegistry` | 注册系列和特征默克尔根；特征至少 5 个持有才能用于估值 |
| 估值 = 承诺买单 | `BidBook` | 集合 / 特征买单，共享担保金；买单挂满 24 小时、资金足够才可估值；被抽中时圈定 3 天供抽中者退出；不支持单品买单估值 |
| 地板做市 | `FloorBook` | Tensor 式双边做市订单：每个做市方自带指数曲线和价差 |
| 盲抽机器 + 返还率锁定 | `Machine`（由 `MachineFactory` 克隆） | 卖家只给底价；按买单估值分档；每抽按在架库存重新求解概率，期望值等于目标；水位：单件结算 ≤ 储备 × 风险系数 |
| 库存收益 | `Machine` | 每抽 1.5% 进收益池，按各档对本抽期望值的贡献分给可抽的寄售卡，档内按估值分；越缺货的档单件分得越多；挂满 3 天可领，7 天内撤回没收给 LP；被抽中时自动随结算付给卖家 |
| 流通分成 | `Machine` | 记录每个 NFT 在本机器的首个寄售人；别人再寄售并卖出时，首个寄售人拿估值的 1%（从卖家溢价里出，LP 不出钱） |
| 保底 | `Machine` | 每抽 1% 进保底池；连续 N 抽（主理人设 20–100，0 关闭）未出稀有及以上，下一抽只在稀有及以上档抽，保底池补给储备额外的期望成本；池子不够时不触发；任何人可用 `fundPity` 预存 |
| 概率买单 | `OddsMarket` | 借鉴 Tensor YOLO Buy：付要价的 q 得到 q 的中奖概率，金库承担波动 |
| LP 储备 | `ReserveVault` | 份额不可转让；取出排队 1 天 |
| 随机数 | `ChainlinkVRFProvider` / `MockRandomnessProvider` | VRF v2.5；回调失败不阻塞，用户可超时退款 |

设计文档：

- [`docs/podmatic-pricing.md`](docs/podmatic-pricing.md)：定价架构（地板 / 特征溢价 / 个体溢价）
- [`docs/podmatic-liquidity.md`](docs/podmatic-liquidity.md)：Tensor 研究与抽卡流量做市
- [`docs/podmatic-v2-design.md`](docs/podmatic-v2-design.md)：v2 产品与经济设计

## 每抽 100 美元的去向（合约默认值）

| 去向 | 金额 | 说明 |
|---|---|---|
| 协议 / 前端 / 主理人 | 1.5 / 1.0 / 最多 3.0 | 主理人默认 2.5 |
| 库存收益池 | 1.5 | 分给在架寄售卡 |
| 保底池 | 1.0 | 保底抽的额外成本 |
| 奖品 | 约 目标返还率 × 1.02 | 卖家拿估值 × 1.02，其中 0.5% 是定价费给买单方，再寄售时 1% 是流通分成给首个寄售人 |
| LP | 剩余 | 返还率 89%、主理人 2.5% 时约 1.7%；返还率越高越薄，可能为负 |

LP 的毛利率 = 1 − 各项费用 − 目标返还率 × 1.02。主理人把返还率调高，就是用 LP 的利润换玩家。

## 测试

```bash
npm test        # 25 个合约测试
```

覆盖特征证明、共享担保金与估值资格、做市曲线、返还率锁定（期望值等于目标）、抽卡结算与按估值退出、过期退款、过期估值重抽、LP 排队、概率买输赢、VRF 转发与回调失败、库存收益的分配 / 归属 / 没收 / 随结算支付、流通分成、保底触发与保底池不足时不触发。

## 部署到 Ethereum / Base

1. 在 [Chainlink VRF](https://vrf.chain.link) 创建 v2.5 订阅并充值。各链的 Coordinator 和 key hash 见 [Supported Networks](https://docs.chain.link/vrf/v2-5/supported-networks)。
2. 配置环境变量（`contracts/.env` 或 shell）：

   ```bash
   PRIVATE_KEY=0x...
   VRF_COORDINATOR=0x...
   VRF_KEY_HASH=0x...
   VRF_SUBSCRIPTION_ID=...
   # 可选：USDC_ADDRESS（默认用 Circle USDC）、TREASURY、SEPOLIA_RPC_URL、BASE_SEPOLIA_RPC_URL、MAINNET_RPC_URL、BASE_RPC_URL
   # 测试网加 DEMO=1 会额外部署演示 NFT 系列并铸给部署者
   ```

3. 部署：

   ```bash
   cd contracts
   npm run deploy:base-sepolia     # 或 deploy:sepolia
   ALLOW_MAINNET=1 npm run deploy:base   # 或 deploy:mainnet；合约未审计，后果自负
   ```

4. 把输出的 `ChainlinkVRFProvider` 地址加为 VRF 订阅的 consumer。
5. 部署脚本会写入 `web/src/generated/deployment.<chainId>.json`，前端自动识别该链。生产构建：

   ```bash
   cd web && cp .env.example .env   # 填 VITE_WALLETCONNECT_PROJECT_ID，关闭 VITE_ENABLE_LOCAL
   npm run build                    # 输出 web/dist，可部署到任意静态托管
   ```

真实系列上线前，需要由注册表 owner（建议多签）调用 `register` 和 `setTraitCounts` 写入该系列的特征快照，并把快照数据（特征与证明）提供给前端。

## 已知限制

- **注册表是许可制**：特征快照由 owner 写入，是 MVP 的信任点。
- **抽卡等待期间锁定估值变更**：有未完成的抽取时，不能刷新估值或撤回在架 NFT，以防有人看到随机数后操纵选卡。繁忙机器可能需要排队；后续可改为按批次快照。
- **USDC 黑名单**：如果卖家地址被 USDC 拉黑，结算会失败，这一抽会在 1 天后可退款。
- **前端只完整支持演示系列**：“我的 NFT”依赖 ERC721Enumerable，特征证明来自部署脚本生成的文件。接入真实系列需要索引器。
- **未实现**：共享启动金库、系列额度互通、以卡入股（见设计文档）。

## 模拟

```bash
pip install numpy
python3 sim/podmatic_sim.py --runs 30 > sim/results.md
python3 sim/premium_sim.py > sim/premium_results.md
python3 sim/mm_sim.py > sim/mm_results.md
python3 sim/pricing_sim.py --runs 20 > sim/pricing_results.md
```

模型假设写在各脚本顶部。
