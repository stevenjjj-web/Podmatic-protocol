import { useState } from "react";
import { useAccount } from "wagmi";
import { floorBookAbi } from "../generated/abis";
import { bestBidsFor, useBids, useFloorOrders, useMyNfts, type FloorOrder } from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { NftArt } from "../components/NftArt";
import { AmountPanel, Empty } from "../components/ui";
import { fmtPct, fmtUsdc, parseUsdc, short } from "../lib/format";
import { COLLECTION_TRAIT, tokenTraits } from "../lib/traits";

const PROTOCOL_FEE = 100n;

function Swap({ orders }: { orders: FloorOrder[] }) {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { tokens } = useMyNfts();
  const { run, busy } = useTx();
  const { ensureToken, ensureNft } = useApprovals();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [token, setToken] = useState<string>("");

  const bestAsk = orders.filter((o) => o.active && o.inventory.length > 0).sort((a, b) => (a.ask < b.ask ? -1 : 1))[0];
  const bestBid = orders.filter((o) => o.active && o.cash >= o.bid && o.bid > 0n).sort((a, b) => (a.bid > b.bid ? -1 : 1))[0];
  const price = side === "buy" ? bestAsk?.ask : bestBid?.bid;
  const fee = price ? (price * PROTOCOL_FEE) / 10000n : 0n;
  const total = side === "buy" ? (price ?? 0n) + fee : (price ?? 0n) - fee;
  const sellToken = token ? BigInt(token) : tokens[0];

  async function submit() {
    if (!deployment) return;
    if (side === "buy" && bestAsk) {
      if (!(await ensureToken(deployment.quote, deployment.floorBook, total))) return;
      await run(`买入地板款 $${fmtUsdc(total)}`, (w) =>
        w({ address: deployment.floorBook, abi: floorBookAbi, functionName: "buyFromOrder", args: [BigInt(bestAsk.id), (total * 101n) / 100n] }),
      );
    } else if (side === "sell" && bestBid && sellToken !== undefined && deployment.demoCollection) {
      if (!(await ensureNft(deployment.demoCollection, deployment.floorBook))) return;
      await run(`卖出 #${Number(sellToken)} $${fmtUsdc(total)}`, (w) =>
        w({ address: deployment.floorBook, abi: floorBookAbi, functionName: "sellToOrder", args: [BigInt(bestBid.id), sellToken, (total * 99n) / 100n] }),
      );
    }
  }

  return (
    <div className="card swap-card stack">
      <div className="tabs">
        <button className={`tab ${side === "buy" ? "active" : ""}`} onClick={() => setSide("buy")}>买入</button>
        <button className={`tab ${side === "sell" ? "active" : ""}`} onClick={() => setSide("sell")}>卖出</button>
      </div>
      {side === "buy" ? (
        <>
          <AmountPanel label="你付出" value={price ? fmtUsdc(total) : ""} readOnly footer={<span>含 1% 协议费</span>} />
          <div className="panel stack-sm">
            <div className="field-label">你得到</div>
            <div className="between">
              <span className="amount-input" style={{ width: "auto" }}>1</span>
              <span className="token-chip">
                {bestAsk ? <NftArt tokenId={bestAsk.inventory[bestAsk.inventory.length - 1]} traits={tokenTraits(collection, bestAsk.inventory[bestAsk.inventory.length - 1])} size={24} rounded={12} /> : null}
                {collection?.name ?? "NFT"} 地板款
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="panel stack-sm">
            <div className="field-label">你卖出</div>
            {tokens.length === 0 ? (
              <div className="muted">你没有可卖的 NFT。</div>
            ) : (
              <select className="select" value={String(sellToken)} onChange={(e) => setToken(e.target.value)}>
                {tokens.map((t) => <option key={String(t)} value={String(t)}>{collection?.name} #{Number(t)}</option>)}
              </select>
            )}
          </div>
          <AmountPanel label="你得到" value={price ? fmtUsdc(total) : ""} readOnly footer={<span>已扣 1% 协议费</span>} />
        </>
      )}
      <div className="stack-sm" style={{ padding: "0 4px" }}>
        <div className="kv"><span>最优订单</span><span>{(side === "buy" ? bestAsk : bestBid) ? `#${(side === "buy" ? bestAsk : bestBid)!.id} · ${short((side === "buy" ? bestAsk : bestBid)!.maker)}` : "—"}</span></div>
        <div className="kv"><span>成交后价格变化</span><span>{(side === "buy" ? bestAsk : bestBid) ? `${side === "buy" ? "+" : "−"}${fmtPct((side === "buy" ? bestAsk : bestBid)!.deltaBps / 1e4, 1)}` : "—"}</span></div>
      </div>
      <button className="btn btn-primary btn-lg" disabled={!address || busy || !price || (side === "sell" && sellToken === undefined)} onClick={submit}>
        {!address ? "先连接钱包" : !price ? "没有可成交的订单" : side === "buy" ? "买入" : "卖出"}
      </button>
    </div>
  );
}

function CreateOrder() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { tokens } = useMyNfts();
  const { bids } = useBids();
  const { run, busy } = useTx();
  const { ensureToken, ensureNft } = useApprovals();
  const [spot, setSpot] = useState("22");
  const [delta, setDelta] = useState("3");
  const [fee, setFee] = useState("4");
  const [cash, setCash] = useState("500");
  const [picked, setPicked] = useState<bigint[]>([]);

  const floorTokens = tokens.filter((t) => {
    const { fill } = bestBidsFor(bids, collection, deployment?.demoCollection, Number(t));
    return !fill || fill.traitKey === COLLECTION_TRAIT;
  });
  const spotV = parseUsdc(spot);
  const deltaBps = Math.round(Number(delta || 0) * 100);
  const feeBps = Math.round(Number(fee || 0) * 100);
  const bid = spotV > 0n ? (((spotV * 10000n) / BigInt(10000 + deltaBps)) * BigInt(10000 - feeBps)) / 10000n : 0n;

  async function submit() {
    if (!deployment?.demoCollection) return;
    const c = parseUsdc(cash);
    if (c > 0n && !(await ensureToken(deployment.quote, deployment.floorBook, c))) return;
    if (picked.length && !(await ensureNft(deployment.demoCollection, deployment.floorBook))) return;
    const ok = await run("创建做市订单", (w) =>
      w({ address: deployment.floorBook, abi: floorBookAbi, functionName: "createOrder", args: [deployment.demoCollection!, spotV, deltaBps, feeBps, c, picked] }),
    );
    if (ok) setPicked([]);
  }

  return (
    <div className="card card-pad stack">
      <div className="h3">创建做市订单</div>
      <div className="grid grid-3">
        <div className="stack-sm"><div className="field-label">起始卖价</div><input className="input mono" value={spot} onChange={(e) => setSpot(e.target.value)} /></div>
        <div className="stack-sm"><div className="field-label">每笔变动 %</div><input className="input mono" value={delta} onChange={(e) => setDelta(e.target.value)} /></div>
        <div className="stack-sm"><div className="field-label">价差费 %</div><input className="input mono" value={fee} onChange={(e) => setFee(e.target.value)} /></div>
      </div>
      <div className="stack-sm"><div className="field-label">放入 USDC（用于买入）</div><input className="input mono" value={cash} onChange={(e) => setCash(e.target.value)} /></div>
      <div className="kv"><span>首笔买价 / 卖价</span><span>${fmtUsdc(bid)} / ${fmtUsdc(spotV)}</span></div>
      <div className="stack-sm">
        <div className="field-label">放入地板款 NFT（{picked.length} 个已选，只列出没有特征买单的）</div>
        {floorTokens.length === 0 ? (
          <div className="small muted">没有可放入的地板款。</div>
        ) : (
          <div className="row wrap" style={{ gap: 6 }}>
            {floorTokens.slice(0, 24).map((t) => {
              const on = picked.includes(t);
              return (
                <button key={String(t)} className={`btn btn-sm ${on ? "btn-soft" : ""}`} onClick={() => setPicked(on ? picked.filter((x) => x !== t) : [...picked, t])}>
                  #{Number(t)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="notice notice-warn">不要放入带稀有特征的 NFT：任何人都能按订单卖价买走它，你换回的是地板价。</div>
      <button className="btn btn-primary btn-lg" disabled={!address || busy || spotV === 0n} onClick={submit}>创建订单</button>
    </div>
  );
}

export function Pool() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { orders } = useFloorOrders();
  const { run, busy } = useTx();
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 className="h2">地板做市</h1>
        <div className="muted">Tensor 式双边做市订单：每个做市方带自己的曲线和价差。抽卡和玩家卖回带来的随机流量为做市付费。</div>
      </div>
      <div className="page-cols">
        <div className="stack" style={{ gap: 20 }}>
          <div className="card card-pad stack">
            <div className="h3">订单簿</div>
            {orders.length === 0 ? (
              <Empty>还没有做市订单。</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>#</th><th>做市方</th><th>买价</th><th>卖价</th><th>变动 / 价差</th><th>USDC</th><th>NFT</th><th /></tr></thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id} style={{ opacity: o.active ? 1 : 0.5 }}>
                        <td>{o.id}</td>
                        <td className="mono">{short(o.maker)}</td>
                        <td className="mono ok">${fmtUsdc(o.bid)}</td>
                        <td className="mono bad">${fmtUsdc(o.ask)}</td>
                        <td>{fmtPct(o.deltaBps / 1e4, 1)} / {fmtPct(o.feeBps / 1e4, 1)}</td>
                        <td className="mono">${fmtUsdc(o.cash, 0)}</td>
                        <td>
                          <div className="row" style={{ gap: 2 }}>
                            {o.inventory.slice(-3).map((t) => <NftArt key={String(t)} tokenId={t} traits={tokenTraits(collection, t)} size={22} rounded={6} />)}
                            <span className="small muted">{o.inventory.length}</span>
                          </div>
                        </td>
                        <td>
                          {address && o.active && o.maker.toLowerCase() === address.toLowerCase() && (
                            <button className="btn btn-sm btn-ghost" disabled={busy}
                              onClick={() => run(`关闭订单 #${o.id}`, (w) => w({ address: deployment!.floorBook, abi: floorBookAbi, functionName: "close", args: [BigInt(o.id)] }))}>
                              关闭
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <CreateOrder />
        </div>
        <div className="sticky"><Swap orders={orders} /></div>
      </div>
    </div>
  );
}
