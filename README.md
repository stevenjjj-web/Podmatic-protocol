# Podmatic Protocol

Market making for collectibles: spinning is trading, listing is market making.

Anyone can open an on-chain draw machine. NFT holders consign NFTs with a floor price only. Every NFT is valued by a bid backed by locked funds, and a winner can always sell the NFT to that bid at its value. LPs fund the machine reserves. Deployment targets are **Ethereum** and **Base** (plus the Sepolia and Base Sepolia testnets).

> ⚠️ The contracts are not audited. Use them locally and on testnets only. The deploy script refuses mainnet unless you set `ALLOW_MAINNET=1`.

## Quick start (local, one command)

Requires Node.js 20+.

```bash
npm run setup   # install contracts and web dependencies
npm run dev     # start a local chain -> deploy and seed demo data -> start the web app
```

Open http://localhost:5173 and click **Connect wallet** → **Local dev wallet**. It uses the Hardhat node's default account, so no MetaMask is needed. The demo data includes:

- 200 Pod Apes demo NFTs with an on-chain trait snapshot; your wallet holds 40 of them and 1M test USDC (top right: get more);
- 8 collection and trait bids that have already rested 24 hours;
- two machines (Standard and Chase) with 110 consigned NFTs and $100k of LP reserve;
- 2 floor market-making orders and 5 odds listings.

Locally, randomness is mocked: after a spin, the web app sends a second transaction that performs the "VRF callback". Testnets and mainnets use Chainlink VRF v2.5.

## Layout

```
contracts/   Solidity contracts, tests and deploy scripts (Hardhat)
web/         Web app (Vite + React + wagmi/viem + RainbowKit)
docs/        Design documents
sim/         Economic simulations (Python)
scripts/     dev.mjs: one-command local environment
```

## Design → contracts

| Design (docs) | Contract | Notes |
|---|---|---|
| Trait snapshot | `CollectionRegistry` | Registers collections and a Merkle root of their traits; a trait needs at least 5 holders to back valuations |
| Value = committed bids | `BidBook` | Collection and trait bids on a shared escrow; a bid can value NFTs once it has rested 24 hours and is funded; when an NFT it values is drawn, the bid is earmarked for the winner's 3-day exit; no single-item bids for valuation |
| Floor market making | `FloorBook` | Tensor-style two-sided orders: each maker brings their own exponential curve and spread |
| Draw machine + return lock | `Machine` (cloned by `MachineFactory`) | Sellers only set a floor; NFTs are tiered by bid value; every spin re-solves the odds from live inventory so the expected value equals the target; water level: a single settlement may not exceed reserve × risk factor |
| Inventory yield | `Machine` | 1.5% of each spin goes to a yield pool, split across drawable tiers by their share of the spin's expected value and within a tier by listing value; thinly stocked tiers pay more per listing; claimable after 3 days, forfeited to LPs on a delist within 7 days, paid with settlement when drawn |
| Circulation royalty | `Machine` | Records each NFT's first consignor in the machine; when someone else re-consigns and sells it, the first consignor gets 1% of its value (paid from the seller premium, not by LPs) |
| Pity | `Machine` | 1% of each spin funds a pity pool; after N spins in a row (creator sets 20–100, 0 disables) without Rare or better, the next spin draws only from Rare and up and the pool pays the reserve the extra expected cost; no pity when the pool is short; anyone can pre-fund it with `fundPity` |
| Odds buys | `OddsMarket` | Inspired by Tensor's YOLO Buy: pay q of the ask for probability q of winning it; the vault carries the variance |
| LP reserve | `ReserveVault` | Non-transferable shares; withdrawals queue for 1 day |
| Randomness | `ChainlinkVRFProvider` / `MockRandomnessProvider` | VRF v2.5; a failing callback does not block fulfilment, and users can reclaim funds after a timeout |

Design documents:

- [`docs/podmatic-pricing.md`](docs/podmatic-pricing.md): pricing architecture (floor / trait premium / individual premium)
- [`docs/podmatic-liquidity.md`](docs/podmatic-liquidity.md): Tensor study and market making funded by gacha flow
- [`docs/podmatic-v2-design.md`](docs/podmatic-v2-design.md): v2 product and economic design

## Where $100 of spins goes (contract defaults)

| Destination | Amount | Notes |
|---|---|---|
| Protocol / frontend / creator | 1.5 / 1.0 / up to 3.0 | creator default 2.5 |
| Inventory yield pool | 1.5 | to consigned listings |
| Pity pool | 1.0 | extra cost of pity spins |
| Prizes | about target return × 1.02 | sellers get value × 1.02, of which 0.5% is the pricing fee to the bidder and, on a re-consignment, 1% is the circulation royalty to the first consignor |
| LPs | residual | about 1.7% at an 89% return and a 2.5% creator fee; thinner as the return rises, and it can be negative |

LP gross margin = 1 − fees − target return × 1.02. A creator who raises the return is trading LP profit for player value.

## Tests

```bash
npm test        # 25 contract tests
```

Covers trait proofs, shared escrow and valuation eligibility, market-making curves, the return lock (expected value equals target), spin settlement and exit at value, timeout refunds, redraws on stale valuations, LP withdrawal queue, odds wins and losses, VRF forwarding and callback failures, inventory yield allocation / vesting / forfeiture / payment on settlement, circulation royalty, and pity triggering (and not triggering when the pool is short).

## Deploying to Ethereum / Base

1. Create and fund a Chainlink VRF v2.5 subscription at [vrf.chain.link](https://vrf.chain.link). Coordinator addresses and key hashes per chain are listed under [Supported Networks](https://docs.chain.link/vrf/v2-5/supported-networks).
2. Set environment variables (`contracts/.env` or the shell):

   ```bash
   PRIVATE_KEY=0x...
   VRF_COORDINATOR=0x...
   VRF_KEY_HASH=0x...
   VRF_SUBSCRIPTION_ID=...
   # Optional: USDC_ADDRESS (defaults to Circle USDC), TREASURY, SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, MAINNET_RPC_URL, BASE_RPC_URL
   # On testnets, DEMO=1 also deploys a demo NFT collection minted to the deployer
   ```

3. Deploy:

   ```bash
   cd contracts
   npm run deploy:base-sepolia            # or deploy:sepolia
   ALLOW_MAINNET=1 npm run deploy:base    # or deploy:mainnet; the contracts are unaudited, at your own risk
   ```

4. Add the printed `ChainlinkVRFProvider` address as a consumer of the VRF subscription.
5. The deploy script writes `web/src/generated/deployment.<chainId>.json`, and the web app picks up that chain automatically. Production build:

   ```bash
   cd web && cp .env.example .env   # set VITE_WALLETCONNECT_PROJECT_ID, turn off VITE_ENABLE_LOCAL
   npm run build                    # outputs web/dist for any static host
   ```

Before a real collection goes live, the registry owner (ideally a multisig) must call `register` and `setTraitCounts` with that collection's trait snapshot, and the snapshot data (traits and proofs) must be made available to the web app.

## Known limitations

- **The registry is permissioned**: the owner writes trait snapshots. This is the MVP's trust point.
- **Valuation changes are locked while spins are pending**: while a draw awaits randomness, listings cannot be revalued or delisted, so nobody can steer the pick after seeing the random word. Busy machines may need to queue; per-batch snapshots are a later fix.
- **USDC blacklist**: if a seller's address is blacklisted by USDC, settlement fails and the spin becomes refundable after 1 day.
- **The web app fully supports the demo collection only**: "My NFTs" relies on ERC721Enumerable and trait proofs come from files written by the deploy script. Real collections need an indexer.
- **Not implemented**: shared bootstrap vault, credits shared across a series, and card-to-LP deposits (see the design docs).

## Simulations

```bash
pip install numpy
python3 sim/podmatic_sim.py --runs 30 > sim/results.md
python3 sim/premium_sim.py > sim/premium_results.md
python3 sim/mm_sim.py > sim/mm_results.md
python3 sim/pricing_sim.py --runs 20 > sim/pricing_results.md
```

Model assumptions are documented at the top of each script.
