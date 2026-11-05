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
| 盲抽机器 + 返还率锁定 | `Machine`（由 `MachineFactory` 克隆） | 卖家只给底价；按买单估值分档；每抽按在架库存重新求解概率，期望值等于目标；卖家得估值 × 1.03，其中 0.5% 作为定价费付给买单方；水位：单件结算 ≤ 储备 × 风险系数 |
| 概率买单 | `OddsMarket` | 借鉴 Tensor YOLO Buy：付要价的 q 得到 q 的中奖概率，金库承担波动 |
| LP 储备 | `ReserveVault` | 份额不可转让；取出排队 1 天 |
| 随机数 | `ChainlinkVRFProvider` / `MockRandomnessProvider` | VRF v2.5；回调失败不阻塞，用户可超时退款 |

设计文档：

- [`docs/podmatic-pricing.md`](docs/podmatic-pricing.md)：定价架构（地板 / 特征溢价 / 个体溢价）
- [`docs/podmatic-liquidity.md`](docs/podmatic-liquidity.md)：Tensor 研究与抽卡流量做市
- [`docs/podmatic-v2-design.md`](docs/podmatic-v2-design.md)：v2 产品与经济设计

## 测试

```bash
npm test        # 19 个合约测试
```

覆盖特征证明、共享担保金与估值资格、做市曲线、返还率锁定（期望值等于目标）、抽卡结算与按估值退出、过期退款、过期估值重抽、LP 排队、概率买输赢、VRF 转发与回调失败。

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
- **未实现**：库存收益曲线、流通分成、保底、共享启动金库、系列额度互通（见设计文档）。

## 模拟

```bash
pip install numpy
python3 sim/podmatic_sim.py --runs 30 > sim/results.md
python3 sim/premium_sim.py > sim/premium_results.md
python3 sim/mm_sim.py > sim/mm_results.md
python3 sim/pricing_sim.py --runs 20 > sim/pricing_results.md
```

模型假设写在各脚本顶部。
