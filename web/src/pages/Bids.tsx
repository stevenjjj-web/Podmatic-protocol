import { useMemo, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Hex } from "viem";
import { bidBookAbi } from "../generated/abis";
import { useBids, type Bid } from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { AmountPanel, Empty, Stat } from "../components/ui";
import { fmtUsdc, parseUsdc, short } from "../lib/format";
import { COLLECTION_TRAIT, traitLabel } from "../lib/traits";

const MIN_TRAIT_HOLDERS = 5;

function status(b: Bid) {
  if (!b.active) return <span className="badge">已撤</span>;
  if (b.remaining === 0) return <span className="badge">已满</span>;
  if (b.eligible) return <span className="badge badge-ok">可估值</span>;
  return <span className="badge badge-warn">挂满 24h 前或资金不足</span>;
}

function Escrow() {
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const { run, busy } = useTx();
  const { ensureToken } = useApprovals();
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const reads = useReadContracts({
    contracts: [
      { address: deployment?.bidBook, abi: bidBookAbi, functionName: "balanceOf", args: address ? [address] : undefined },
      { address: deployment?.bidBook, abi: bidBookAbi, functionName: "earmarkedOf", args: address ? [address] : undefined },
    ],
    query: { enabled: !!deployment && !!address, refetchInterval: 4000 },
  });
  const balance = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const earmarked = (reads.data?.[1]?.result as bigint | undefined) ?? 0n;
  const value = parseUsdc(amount);

  async function submit() {
    if (!deployment || value === 0n) return;
    if (mode === "deposit") {
      if (!(await ensureToken(deployment.quote, deployment.bidBook, value))) return;
      await run(`存入担保金 $${fmtUsdc(value)}`, (w) => w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "deposit", args: [value] }));
    } else {
      await run(`取出担保金 $${fmtUsdc(value)}`, (w) => w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "withdraw", args: [value] }));
    }
    setAmount("");
  }

  return (
    <div className="card swap-card stack">
      <div className="between">
        <div className="tabs">
          <button className={`tab ${mode === "deposit" ? "active" : ""}`} onClick={() => setMode("deposit")}>存入</button>
          <button className={`tab ${mode === "withdraw" ? "active" : ""}`} onClick={() => setMode("withdraw")}>取出</button>
        </div>
        <span className="small muted">共享担保金</span>
      </div>
      <div className="grid grid-3" style={{ gap: 8 }}>
        <Stat label="余额" value={`$${fmtUsdc(balance, 0)}`} />
        <Stat label="已圈定" value={`$${fmtUsdc(earmarked, 0)}`} hint="抽中者 3 天退出窗口" />
        <Stat label="可用" value={`$${fmtUsdc(balance - earmarked, 0)}`} />
      </div>
      <AmountPanel label={mode === "deposit" ? "存入金额" : "取出金额"} value={amount} onChange={setAmount} />
      <button className="btn btn-primary btn-lg" disabled={!address || busy || value === 0n} onClick={submit}>
        {mode === "deposit" ? "存入" : "取出"}
      </button>
      <div className="small faint">一笔余额同时支撑你所有的买单；某笔买单的单价超过可用余额时，它暂时失效。</div>
    </div>
  );
}

function PlaceBid() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { run, busy } = useTx();
  const [trait, setTrait] = useState<Hex>(COLLECTION_TRAIT);
  const [price, setPrice] = useState("");
  const [fills, setFills] = useState("5");
  const options = useMemo(
    () =>
      collection
        ? Object.entries(collection.counts)
            .filter(([, c]) => c >= MIN_TRAIT_HOLDERS)
            .sort((a, b) => (collection.labels[a[0]] > collection.labels[b[0]] ? 1 : -1))
        : [],
    [collection],
  );
  const p = parseUsdc(price);
  return (
    <div className="card card-pad stack">
      <div className="h3">挂一笔买单</div>
      <div className="stack-sm">
        <div className="field-label">买什么</div>
        <select className="select" value={trait} onChange={(e) => setTrait(e.target.value as Hex)}>
          <option value={COLLECTION_TRAIT}>全系列任意一个（地板买单）</option>
          {options.map(([key, count]) => (
            <option key={key} value={key}>{traitLabel(collection, key as Hex)}（{count} 个持有）</option>
          ))}
        </select>
      </div>
      <div className="grid grid-2">
        <div className="stack-sm">
          <div className="field-label">单价 (USDC)</div>
          <input className="input mono" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
        </div>
        <div className="stack-sm">
          <div className="field-label">最多买几个</div>
          <input className="input mono" value={fills} onChange={(e) => setFills(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
      </div>
      <div className="notice notice-neutral">
        买单挂满 24 小时、余额足够时，才会被用来给机器里的 NFT 估值。抽中者可以按你的出价把 NFT 卖给你，你同时拿到估值 0.5% 的定价费。只支持全系列和特征买单（至少 {MIN_TRAIT_HOLDERS} 个持有），不能给单个 NFT 估值。
      </div>
      <button
        className="btn btn-primary btn-lg"
        disabled={!address || busy || p === 0n || !deployment?.demoCollection}
        onClick={() =>
          run(`挂买单 $${fmtUsdc(p)} × ${fills}`, (w) =>
            w({ address: deployment!.bidBook, abi: bidBookAbi, functionName: "placeBid", args: [deployment!.demoCollection!, trait, p, Number(fills || "1")] }),
          ).then((r) => r && setPrice(""))
        }
      >
        挂买单
      </button>
    </div>
  );
}

export function Bids() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { bids } = useBids();
  const { run, busy } = useTx();

  const depth = useMemo(() => {
    const g = new Map<string, { key: Hex; best: bigint; count: number; size: number; eligible: number }>();
    for (const b of bids) {
      if (!b.active || b.remaining === 0) continue;
      const row = g.get(b.traitKey) ?? { key: b.traitKey, best: 0n, count: 0, size: 0, eligible: 0 };
      row.best = b.price > row.best ? b.price : row.best;
      row.count += 1;
      row.size += b.remaining;
      row.eligible += b.eligible ? 1 : 0;
      g.set(b.traitKey, row);
    }
    return [...g.values()].sort((a, b) => (a.best > b.best ? -1 : 1));
  }, [bids]);
  const mine = bids.filter((b) => address && b.bidder.toLowerCase() === address.toLowerCase() && b.active);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 className="h2">买单</h1>
        <div className="muted">估值 = 承诺买单。你的买单决定了 NFT 在机器里值多少钱，估得准有定价费，估高了要按高价接盘。</div>
      </div>
      <div className="page-cols">
        <div className="stack" style={{ gap: 20 }}>
          <div className="card card-pad stack">
            <div className="between"><div className="h3">买单深度</div><span className="small muted">{collection?.name}</span></div>
            {depth.length === 0 ? (
              <Empty>还没有买单。</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>特征</th><th>最高出价</th><th>买单数</th><th>可买数量</th><th>可估值</th></tr></thead>
                  <tbody>
                    {depth.map((r) => (
                      <tr key={r.key}>
                        <td>{traitLabel(collection, r.key)}</td>
                        <td className="mono">${fmtUsdc(r.best)}</td>
                        <td>{r.count}</td>
                        <td>{r.size}</td>
                        <td>{r.eligible > 0 ? <span className="badge badge-ok">{r.eligible} 笔</span> : <span className="badge">0</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card card-pad stack">
            <div className="h3">我的买单</div>
            {mine.length === 0 ? (
              <Empty>{address ? "你还没有挂买单。" : "连接钱包查看。"}</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>#</th><th>特征</th><th>单价</th><th>剩余</th><th>状态</th><th /></tr></thead>
                  <tbody>
                    {mine.map((b) => (
                      <tr key={b.id}>
                        <td>{b.id}</td>
                        <td>{traitLabel(collection, b.traitKey)}</td>
                        <td className="mono">${fmtUsdc(b.price)}</td>
                        <td>{b.remaining}</td>
                        <td>{status(b)}</td>
                        <td>
                          <button className="btn btn-sm btn-ghost" disabled={busy}
                            onClick={() => run(`撤销买单 #${b.id}`, (w) => w({ address: deployment!.bidBook, abi: bidBookAbi, functionName: "cancelBid", args: [BigInt(b.id)] }))}>
                            撤销
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card card-pad stack">
            <div className="h3">全部买单</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>出价人</th><th>特征</th><th>单价</th><th>剩余</th><th>状态</th></tr></thead>
                <tbody>
                  {bids.filter((b) => b.active).map((b) => (
                    <tr key={b.id}>
                      <td>{b.id}</td>
                      <td className="mono">{short(b.bidder)}</td>
                      <td>{traitLabel(collection, b.traitKey)}</td>
                      <td className="mono">${fmtUsdc(b.price)}</td>
                      <td>{b.remaining}</td>
                      <td>{status(b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="stack sticky" style={{ gap: 20 }}>
          <Escrow />
          <PlaceBid />
        </div>
      </div>
    </div>
  );
}
