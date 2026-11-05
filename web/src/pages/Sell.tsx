import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { parseEventLogs, type Address, type Hex } from "viem";
import { bidBookAbi, floorBookAbi, machineAbi, oddsAbi } from "../generated/abis";
import {
  bestBidsFor, useBids, useFloorOrders, useMachineAddresses, useMachines, useMyNfts, useOddsListings,
  type Bid, type MachineInfo,
} from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { useChainTime } from "../hooks/useEvents";
import { NftTile, TraitList } from "../components/NftTile";
import { NftArt } from "../components/NftArt";
import { AmountPanel, Empty, Skeleton, TIER_NAMES } from "../components/ui";
import { fmtDuration, fmtUsdc, parseUsdc } from "../lib/format";
import { COLLECTION_TRAIT, proofFor, tokenTraitKeys, tokenTraits, traitLabel } from "../lib/traits";

type Exit = "bid" | "machine" | "pool" | "odds";
const PREMIUM_BPS = 300n;

function tierFor(m: MachineInfo, value: bigint) {
  return m.tiers.findIndex((t) => value >= t.minValue && value <= t.maxValue);
}

function SellPanel({ tokenId, bids, onDone }: { tokenId: bigint; bids: Bid[]; onDone: () => void }) {
  const { deployment, collection } = useDeployment();
  const { machines } = useMachines();
  const { orders } = useFloorOrders();
  const { run, busy } = useTx();
  const { ensureNft } = useApprovals();
  const client = usePublicClient();
  const nft = deployment?.demoCollection;
  const [exit, setExit] = useState<Exit>("machine");
  const [machineAddr, setMachineAddr] = useState<Address | undefined>();
  const [floor, setFloor] = useState("");
  const [ask, setAsk] = useState("");

  const { fill, valuation } = bestBidsFor(bids, collection, nft, Number(tokenId));
  const bestOrder = [...orders]
    .filter((o) => o.active && o.cash >= o.bid)
    .sort((a, b) => (a.bid > b.bid ? -1 : 1))[0];
  const machine = machines.find((m) => m.address === machineAddr) ?? machines[0];
  const defaultFloor = valuation ? fmtUsdc((valuation.price * 97n) / 100n).replace(/,/g, "") : "";
  const floorValue = parseUsdc(floor || defaultFloor || "0");
  const settlement = valuation ? (valuation.price * (10000n + PREMIUM_BPS)) / 10000n : 0n;
  const tier = valuation && machine ? tierFor(machine, valuation.price) : -1;
  const drawable = !!valuation && tier >= 0 && settlement >= floorValue;

  // Trait to prove when consigning: the one the best valuation bid uses, else the trait with the highest active bid.
  const traitForListing: Hex = valuation?.traitKey ?? fill?.traitKey ?? COLLECTION_TRAIT;

  async function sellToBid() {
    if (!nft || !deployment || !fill) return;
    if (!(await ensureNft(nft, deployment.bidBook))) return;
    const ok = await run(`卖给买单 · $${fmtUsdc(fill.price)}`, (w) =>
      w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "fill", args: [BigInt(fill.id), tokenId, proofFor(collection, tokenId, fill.traitKey), fill.price] }),
    );
    if (ok) onDone();
  }

  async function consign() {
    if (!nft || !machine || !client) return;
    if (!(await ensureNft(nft, machine.address))) return;
    const receipt = await run(`寄售到 ${machine.name}`, (w) =>
      w({ address: machine.address, abi: machineAbi, functionName: "list", args: [tokenId, floorValue, traitForListing, proofFor(collection, tokenId, traitForListing)] }),
    );
    if (!receipt) return;
    const [listed] = parseEventLogs({ abi: machineAbi, logs: receipt.logs, eventName: "Listed" });
    if (listed && valuation) {
      await run("按买单估值，进入可抽区间", (w) =>
        w({ address: machine.address, abi: machineAbi, functionName: "refreshValuation", args: [listed.args.listingId, BigInt(valuation.id)] }),
      );
    }
    onDone();
  }

  async function sellToPool() {
    if (!nft || !deployment || !bestOrder) return;
    if (!(await ensureNft(nft, deployment.floorBook))) return;
    const minOut = (bestOrder.bid * 98n) / 100n;
    const ok = await run(`卖进做市订单 · $${fmtUsdc(bestOrder.bid)}`, (w) =>
      w({ address: deployment.floorBook, abi: floorBookAbi, functionName: "sellToOrder", args: [BigInt(bestOrder.id), tokenId, minOut] }),
    );
    if (ok) onDone();
  }

  async function listOdds() {
    if (!nft || !deployment) return;
    const a = parseUsdc(ask);
    if (a === 0n) return;
    if (!(await ensureNft(nft, deployment.odds))) return;
    const ok = await run(`概率出售 · 要价 $${fmtUsdc(a)}`, (w) =>
      w({ address: deployment.odds, abi: oddsAbi, functionName: "list", args: [nft, tokenId, a] }),
    );
    if (ok) onDone();
  }

  return (
    <div className="card swap-card stack sticky">
      <div className="row">
        <NftArt tokenId={tokenId} traits={tokenTraits(collection, tokenId)} size={64} rounded={14} />
        <div className="stack-sm">
          <div className="h3">{collection?.name} #{Number(tokenId)}</div>
          <TraitList tokenId={tokenId} />
        </div>
      </div>
      <div className="grid grid-2" style={{ gap: 8 }}>
        <div className="panel stack-sm">
          <div className="small muted">现在就能卖</div>
          <div className="stat-value">{fill ? `$${fmtUsdc(fill.price)}` : "—"}</div>
          <div className="small faint">{fill ? traitLabel(collection, fill.traitKey) : "没有买单"}</div>
        </div>
        <div className="panel stack-sm">
          <div className="small muted">机器估值</div>
          <div className="stat-value">{valuation ? `$${fmtUsdc(valuation.price)}` : "—"}</div>
          <div className="small faint">{valuation ? "有效买单（已满 24 小时）" : "暂无有效买单"}</div>
        </div>
      </div>

      <div className="segmented" style={{ alignSelf: "stretch", display: "grid", gridTemplateColumns: "repeat(4,1fr)" }}>
        {([["machine", "放进机器"], ["bid", "卖给买单"], ["pool", "卖进做市"], ["odds", "概率出售"]] as [Exit, string][]).map(([k, l]) => (
          <button key={k} className={exit === k ? "active" : ""} onClick={() => setExit(k)}>{l}</button>
        ))}
      </div>

      {exit === "machine" && (
        <div className="stack">
          <select className="select" value={machine?.address} onChange={(e) => setMachineAddr(e.target.value as Address)}>
            {machines.map((m) => <option key={m.address} value={m.address}>{m.name}</option>)}
          </select>
          <AmountPanel
            label="底价：低于这个价不卖"
            value={floor || defaultFloor}
            onChange={setFloor}
            footer={<><span>被抽中时到手 ≈ ${fmtUsdc((settlement * 995n) / 1000n)}</span><span>估值 × 1.03 − 0.5% 定价费</span></>}
          />
          {valuation ? (
            drawable ? (
              <div className="notice notice-info">✓ 进入{TIER_NAMES[tier]}档，可被抽中。成交价由买单决定，与底价无关。</div>
            ) : (
              <div className="notice notice-warn">
                {tier < 0 ? "估值不在这台机器的档位范围内。" : "底价高于估值 × 1.03，暂时不会被抽中；买单涨上来后会自动进入区间。"}
              </div>
            )
          ) : (
            <div className="notice notice-neutral">还没有能给它估值的有效买单。可以先寄售，等买单出现后任何人都能刷新估值。</div>
          )}
          <button className="btn btn-primary btn-lg" disabled={busy || !machine} onClick={consign}>寄售到机器</button>
        </div>
      )}

      {exit === "bid" && (
        <div className="stack">
          <div className="panel stack-sm">
            <div className="kv"><span>最高买单</span><span>{fill ? `$${fmtUsdc(fill.price)}` : "—"}</span></div>
            <div className="kv"><span>买单类型</span><span>{fill ? traitLabel(collection, fill.traitKey) : "—"}</span></div>
            <div className="kv"><span>到手（扣 1% 协议费）</span><span>{fill ? `$${fmtUsdc((fill.price * 99n) / 100n)}` : "—"}</span></div>
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy || !fill} onClick={sellToBid}>
            {fill ? "立即卖出" : "没有可成交的买单"}
          </button>
        </div>
      )}

      {exit === "pool" && (
        <div className="stack">
          <div className="notice notice-neutral">做市订单只按地板价收。带稀有特征的 NFT 卖进去会损失溢价。</div>
          <div className="panel stack-sm">
            <div className="kv"><span>最优做市买价</span><span>{bestOrder ? `$${fmtUsdc(bestOrder.bid)}` : "—"}</span></div>
            <div className="kv"><span>到手（扣 1% 协议费）</span><span>{bestOrder ? `$${fmtUsdc((bestOrder.bid * 99n) / 100n)}` : "—"}</span></div>
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy || !bestOrder} onClick={sellToPool}>卖进做市订单</button>
        </div>
      )}

      {exit === "odds" && (
        <div className="stack">
          <AmountPanel label="要价：有人抽中时你拿到的钱（另加 1.5% 奖励）" value={ask} onChange={setAsk} />
          <div className="notice notice-neutral">
            买家按要价的 1%–50% 购买中奖概率，金库承担波动。买家看得到这件 NFT，要价太高就没人买。
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy || !ask} onClick={listOdds}>挂到概率买</button>
        </div>
      )}
    </div>
  );
}

function PendingExits() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { data: machines } = useMachineAddresses();
  const client = usePublicClient();
  const now = useChainTime();
  const { run, busy } = useTx();
  const { ensureNft } = useApprovals();
  const { isLocal } = useDeployment();
  const { data: won = [] } = useQuery({
    queryKey: ["won", address, machines.join()],
    enabled: !!client && !!address && machines.length > 0,
    refetchInterval: 5000,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const fromBlock = isLocal || latest < 50_000n ? 0n : latest - 50_000n;
      const all = await Promise.all(
        machines.map((m) => client!.getContractEvents({ address: m, abi: machineAbi, eventName: "SpinSettled", args: { player: address }, fromBlock })),
      );
      return all.flat().map((e) => ({ tokenId: e.args.tokenId!, earmarkId: e.args.earmarkId! }));
    },
  });

  const marks = useReadContracts({
    contracts: won.map((w) => ({ address: deployment?.bidBook, abi: bidBookAbi, functionName: "earmarks" as const, args: [w.earmarkId] as const })),
    query: { enabled: won.length > 0 && !!deployment, refetchInterval: 4000 },
  });
  const open = won
    .map((w, i) => ({ ...w, e: marks.data?.[i]?.result as { open: boolean; expiry: bigint; amount: bigint } | undefined }))
    .filter((x) => x.e?.open && now !== undefined && x.e.expiry >= now);
  if (!open.length) return null;
  return (
    <div className="card card-pad stack">
      <div className="h3">抽中的 NFT：可按估值卖出</div>
      {open.map((x) => (
        <div key={String(x.earmarkId)} className="between">
          <div className="row">
            <NftArt tokenId={x.tokenId} traits={tokenTraits(collection, x.tokenId)} size={44} rounded={10} />
            <div>
              <div style={{ fontWeight: 535 }}>#{Number(x.tokenId)}</div>
              <div className="small muted">剩余 {fmtDuration(Number(x.e!.expiry - now!))}</div>
            </div>
          </div>
          <button
            className="btn btn-soft btn-sm"
            disabled={busy}
            onClick={async () => {
              if (!deployment?.demoCollection || !(await ensureNft(deployment.demoCollection, deployment.bidBook))) return;
              await run(`按估值卖出 #${Number(x.tokenId)}`, (w) =>
                w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "fillEarmark", args: [x.earmarkId] }),
              );
            }}
          >
            卖出 ${fmtUsdc((x.e!.amount * 99n) / 100n)}
          </button>
        </div>
      ))}
    </div>
  );
}

function MyListings() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { machines } = useMachines();
  const { listings: oddsListings } = useOddsListings();
  const { run, busy } = useTx();
  const calls = machines.flatMap((m) =>
    Array.from({ length: Number(m.listingCount) }, (_, i) => ({ address: m.address, abi: machineAbi, functionName: "listings" as const, args: [BigInt(i)] as const })),
  );
  const rows = useReadContracts({ contracts: calls, query: { enabled: calls.length > 0, refetchInterval: 5000 } });
  const mine = (rows.data ?? [])
    .map((r, i) => ({ l: r.result as { seller: Address; tokenId: bigint; floorPrice: bigint; value: bigint; status: number; tier: number } | undefined, call: calls[i] }))
    .filter((x) => x.l && address && x.l.seller.toLowerCase() === address.toLowerCase() && (x.l.status === 1 || x.l.status === 2));
  const myOdds = oddsListings.filter((l) => address && l.seller.toLowerCase() === address.toLowerCase() && l.active);
  if (!mine.length && !myOdds.length) return null;
  return (
    <div className="card card-pad stack">
      <div className="h3">我挂出的</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>NFT</th><th>位置</th><th>底价 / 要价</th><th>估值</th><th>状态</th><th /></tr></thead>
          <tbody>
            {mine.map(({ l, call }) => {
              const m = machines.find((x) => x.address === call.address)!;
              return (
                <tr key={`${call.address}-${call.args[0]}`}>
                  <td><div className="row"><NftArt tokenId={l!.tokenId} traits={tokenTraits(collection, l!.tokenId)} size={32} rounded={8} />#{Number(l!.tokenId)}</div></td>
                  <td>{m.name}</td>
                  <td>${fmtUsdc(l!.floorPrice)}</td>
                  <td>{l!.value ? `$${fmtUsdc(l!.value)}` : "—"}</td>
                  <td>{l!.status === 2 ? <span className="badge badge-ok">可抽 · {TIER_NAMES[l!.tier]}</span> : <span className="badge">区间外</span>}</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" disabled={busy}
                      onClick={() => run(`撤回 #${Number(l!.tokenId)}`, (w) => w({ address: call.address, abi: machineAbi, functionName: "delist", args: call.args }))}>
                      撤回
                    </button>
                  </td>
                </tr>
              );
            })}
            {myOdds.map((l) => (
              <tr key={`odds-${l.id}`}>
                <td><div className="row"><NftArt tokenId={l.tokenId} traits={tokenTraits(collection, l.tokenId)} size={32} rounded={8} />#{Number(l.tokenId)}</div></td>
                <td>概率买</td>
                <td>${fmtUsdc(l.ask)}</td>
                <td>—</td>
                <td>{l.pending ? <span className="badge badge-warn">开奖中</span> : <span className="badge badge-ok">挂出中</span>}</td>
                <td>
                  <button className="btn btn-sm btn-ghost" disabled={busy || l.pending}
                    onClick={() => run(`撤回 #${Number(l.tokenId)}`, (w) => w({ address: deployment!.odds, abi: oddsAbi, functionName: "delist", args: [BigInt(l.id)] }))}>
                    撤回
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Sell() {
  const { address } = useAccount();
  const { collection, deployment } = useDeployment();
  const { tokens, isLoading } = useMyNfts();
  const { bids } = useBids();
  const [selected, setSelected] = useState<bigint | undefined>();
  const current = selected !== undefined && tokens.includes(selected) ? selected : tokens[0];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 className="h2">挂卡</h1>
        <div className="muted">卖家只给底价，成交价交给买单。四个出口任选：放进机器、直接卖给买单、卖进做市订单、概率出售。</div>
      </div>
      <PendingExits />
      <div className="page-cols">
        <div className="card card-pad stack">
          <div className="between">
            <div className="h3">我的 NFT</div>
            <span className="small muted">{tokens.length} 件</span>
          </div>
          {!address ? (
            <Empty>连接钱包后查看你的 NFT。</Empty>
          ) : !deployment?.demoCollection ? (
            <Empty>这条链上没有注册演示系列。</Empty>
          ) : isLoading ? (
            <div className="grid grid-nft">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={200} />)}</div>
          ) : tokens.length === 0 ? (
            <Empty>你还没有 {collection?.name}。可以去抽一个，或在做市页买一个地板款。</Empty>
          ) : (
            <div className="grid grid-nft">
              {tokens.map((id) => {
                const { fill } = bestBidsFor(bids, collection, deployment.demoCollection, Number(id));
                const rare = tokenTraitKeys(collection, id).some((k) => fill?.traitKey === k);
                return (
                  <NftTile key={String(id)} tokenId={id} selected={id === current} onClick={() => setSelected(id)}>
                    <div className="between small">
                      <span className="muted">{fill ? `$${fmtUsdc(fill.price)}` : "无买单"}</span>
                      {rare && <span className="badge badge-accent">特征</span>}
                    </div>
                  </NftTile>
                );
              })}
            </div>
          )}
        </div>
        {current !== undefined && <SellPanel tokenId={current} bids={bids} onDone={() => setSelected(undefined)} />}
      </div>
      <MyListings />
    </div>
  );
}
