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
  if (!b.active) return <span className="badge">Cancelled</span>;
  if (b.remaining === 0) return <span className="badge">Filled</span>;
  if (b.eligible) return <span className="badge badge-ok">Can value</span>;
  return <span className="badge badge-warn">Under 24h or underfunded</span>;
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
      await run(`Deposit $${fmtUsdc(value)} to escrow`, (w) => w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "deposit", args: [value] }));
    } else {
      await run(`Withdraw $${fmtUsdc(value)} from escrow`, (w) => w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "withdraw", args: [value] }));
    }
    setAmount("");
  }

  return (
    <div className="card swap-card stack">
      <div className="between">
        <div className="tabs">
          <button className={`tab ${mode === "deposit" ? "active" : ""}`} onClick={() => setMode("deposit")}>Deposit</button>
          <button className={`tab ${mode === "withdraw" ? "active" : ""}`} onClick={() => setMode("withdraw")}>Withdraw</button>
        </div>
        <span className="small muted">Shared escrow</span>
      </div>
      <div className="grid grid-3" style={{ gap: 8 }}>
        <Stat label="Balance" value={`$${fmtUsdc(balance, 0)}`} />
        <Stat label="Earmarked" value={`$${fmtUsdc(earmarked, 0)}`} hint="Winners' 3-day exit window" />
        <Stat label="Available" value={`$${fmtUsdc(balance - earmarked, 0)}`} />
      </div>
      <AmountPanel label={mode === "deposit" ? "Deposit amount" : "Withdraw amount"} value={amount} onChange={setAmount} />
      <button className="btn btn-primary btn-lg" disabled={!address || busy || value === 0n} onClick={submit}>
        {mode === "deposit" ? "Deposit" : "Withdraw"}
      </button>
      <div className="small faint">One balance backs all your bids. A bid whose price exceeds your available balance is inactive until you top up.</div>
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
      <div className="h3">Place a bid</div>
      <div className="stack-sm">
        <div className="field-label">What to buy</div>
        <select className="select" value={trait} onChange={(e) => setTrait(e.target.value as Hex)}>
          <option value={COLLECTION_TRAIT}>Any token in the collection (floor bid)</option>
          {options.map(([key, count]) => (
            <option key={key} value={key}>{traitLabel(collection, key as Hex)} ({count} holders)</option>
          ))}
        </select>
      </div>
      <div className="grid grid-2">
        <div className="stack-sm">
          <div className="field-label">Price (USDC)</div>
          <input className="input mono" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
        </div>
        <div className="stack-sm">
          <div className="field-label">Max fills</div>
          <input className="input mono" value={fills} onChange={(e) => setFills(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
      </div>
      <div className="notice notice-neutral">
        A bid values NFTs in machines once it has rested 24 hours and is funded. Winners can sell the NFT to you at your price, and you earn a 0.5% pricing fee on the value. Only collection and trait bids (at least {MIN_TRAIT_HOLDERS} holders) are supported; single NFTs cannot be appraised.
      </div>
      <button
        className="btn btn-primary btn-lg"
        disabled={!address || busy || p === 0n || !deployment?.demoCollection}
        onClick={() =>
          run(`Place bid $${fmtUsdc(p)} × ${fills}`, (w) =>
            w({ address: deployment!.bidBook, abi: bidBookAbi, functionName: "placeBid", args: [deployment!.demoCollection!, trait, p, Number(fills || "1")] }),
          ).then((r) => r && setPrice(""))
        }
      >
        Place bid
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
        <h1 className="h2">Bids</h1>
        <div className="muted">Value = committed bids. Your bids decide what NFTs are worth in machines: price well and you earn pricing fees, price too high and you buy at that price.</div>
      </div>
      <div className="page-cols">
        <div className="stack" style={{ gap: 20 }}>
          <div className="card card-pad stack">
            <div className="between"><div className="h3">Bid depth</div><span className="small muted">{collection?.name}</span></div>
            {depth.length === 0 ? (
              <Empty>No bids yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Trait</th><th>Best bid</th><th>Bids</th><th>Size</th><th>Can value</th></tr></thead>
                  <tbody>
                    {depth.map((r) => (
                      <tr key={r.key}>
                        <td>{traitLabel(collection, r.key)}</td>
                        <td className="mono">${fmtUsdc(r.best)}</td>
                        <td>{r.count}</td>
                        <td>{r.size}</td>
                        <td>{r.eligible > 0 ? <span className="badge badge-ok">{r.eligible}</span> : <span className="badge">0</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card card-pad stack">
            <div className="h3">My bids</div>
            {mine.length === 0 ? (
              <Empty>{address ? "You have no bids yet." : "Connect a wallet to see your bids."}</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>#</th><th>Trait</th><th>Price</th><th>Remaining</th><th>Status</th><th /></tr></thead>
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
                            onClick={() => run(`Cancel bid #${b.id}`, (w) => w({ address: deployment!.bidBook, abi: bidBookAbi, functionName: "cancelBid", args: [BigInt(b.id)] }))}>
                            Cancel
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
            <div className="h3">All bids</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>Bidder</th><th>Trait</th><th>Price</th><th>Remaining</th><th>Status</th></tr></thead>
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
