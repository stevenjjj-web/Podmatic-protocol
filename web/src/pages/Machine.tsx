import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { parseEventLogs, zeroAddress, type Address } from "viem";
import { bidBookAbi, machineAbi, mockRandomnessAbi } from "../generated/abis";
import { useMachines, usePity, type MachineInfo, type Odds } from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { useContractEvents } from "../hooks/useEvents";
import { NftArt } from "../components/NftArt";
import { NftTile, TraitList } from "../components/NftTile";
import { Empty, Modal, Skeleton, Stat, TIER_COLORS, TIER_NAMES } from "../components/ui";
import { fmtPct, fmtUsdc, prob, short } from "../lib/format";
import { tokenTraits } from "../lib/traits";

const FEE_BPS = { protocol: 150, frontend: 100, inventory: 150, pity: 100 };

type Result =
  | { kind: "won"; tokenId: bigint; tier: number; value: bigint; earmarkId: bigint; pity: boolean }
  | { kind: "refunded" }
  | { kind: "waiting" };

function OddsTable({ m, odds }: { m: MachineInfo; odds: Odds }) {
  return (
    <div className="stack-sm">
      {m.tiers.map((t, k) => {
        const p = prob(odds.probs[k] ?? 0n);
        const live = odds.live[k] && (odds.probs[k] ?? 0n) > 0n;
        return (
          <div key={k} className="tier-row">
            <div className="tier-name">
              <span className="tier-dot" style={{ background: TIER_COLORS[k] }} />
              {TIER_NAMES[k]}
            </div>
            <div className="stack-sm" style={{ gap: 4 }}>
              <div className="bar">
                <div style={{ width: `${Math.min(100, p * 100 * (k === 0 ? 1 : 3))}%`, background: TIER_COLORS[k], opacity: live ? 1 : 0.25 }} />
              </div>
              <div className="between small muted">
                <span>
                  ${fmtUsdc(t.minValue, 0)}–{fmtUsdc(t.maxValue, 0)} · {m.tierSizes[k]} listed
                </span>
                <span>{live ? `avg $${fmtUsdc(odds.evs[k] ?? 0n)}` : !odds.live[k] && m.tierSizes[k] ? "above reserve cap" : m.tierSizes[k] ? "not in this spin" : "out of stock"}</span>
              </div>
            </div>
            <div className="mono" style={{ textAlign: "right", fontWeight: 535 }}>
              {live ? fmtPct(p) : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Inventory({ m }: { m: MachineInfo }) {
  const [picked, setPicked] = useState<number | null>(null);
  const tier = picked ?? Math.max(0, m.tierSizes.findLastIndex((s) => s > 0));
  const setTier = setPicked;
  const ids = useReadContracts({
    contracts: [{ address: m.address, abi: machineAbi, functionName: "tierListings", args: [BigInt(tier)] }],
  });
  const listingIds = ((ids.data?.[0]?.result as readonly bigint[] | undefined) ?? []).slice(0, 24);
  const rows = useReadContracts({
    contracts: listingIds.map((id) => ({ address: m.address, abi: machineAbi, functionName: "listings" as const, args: [id] as const })),
    query: { enabled: listingIds.length > 0 },
  });
  return (
    <div className="card card-pad stack">
      <div className="between wrap">
        <div className="h3">What's in the machine</div>
        <div className="tabs wrap">
          {m.tiers.map((_, k) => (
            <button key={k} className={`tab ${tier === k ? "active" : ""}`} onClick={() => setTier(k)}>
              {TIER_NAMES[k]} {m.tierSizes[k]}
            </button>
          ))}
        </div>
      </div>
      {listingIds.length === 0 ? (
        <Empty>No drawable NFTs in this tier right now.</Empty>
      ) : (
        <div className="grid grid-nft">
          {(rows.data ?? []).map((r, i) => {
            const l = r.result as { tokenId: bigint; value: bigint } | undefined;
            if (!l) return <Skeleton key={i} h={200} />;
            return (
              <NftTile key={String(listingIds[i])} tokenId={l.tokenId}>
                <div className="small muted">Value ${fmtUsdc(l.value)}</div>
              </NftTile>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecentPulls({ m }: { m: MachineInfo }) {
  const { collection } = useDeployment();
  const { data } = useContractEvents({ address: m.address, abi: machineAbi, eventName: "SpinSettled" });
  const pulls = (data ?? []).slice(0, 8);
  return (
    <div className="card card-pad stack">
      <div className="h3">Recent pulls</div>
      {pulls.length === 0 ? (
        <Empty>No pulls yet.</Empty>
      ) : (
        pulls.map((e) => {
          const a = e.args as { player: Address; tokenId: bigint; tier: number; value: bigint };
          return (
            <div key={`${e.transactionHash}-${e.logIndex}`} className="between">
              <div className="row">
                <NftArt tokenId={a.tokenId} traits={tokenTraits(collection, a.tokenId)} size={40} rounded={10} />
                <div>
                  <div style={{ fontWeight: 535 }}>#{Number(a.tokenId)}</div>
                  <div className="small muted">{short(a.player)}</div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="small" style={{ color: TIER_COLORS[a.tier] }}>{TIER_NAMES[a.tier]}</div>
                <div className="mono">${fmtUsdc(a.value)}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function SpinCard({ m }: { m: MachineInfo }) {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const client = usePublicClient();
  const { run, busy } = useTx();
  const { ensureToken, ensureNft } = useApprovals();
  const [result, setResult] = useState<Result | null>(null);

  const fees = (m.spinPrice * BigInt(FEE_BPS.protocol + FEE_BPS.frontend + FEE_BPS.inventory + FEE_BPS.pity + m.creatorFeeBps)) / 10000n;
  const pity = usePity(m.address);
  const cap = ((m.totalAssets + m.spinPrice - fees) * BigInt(m.riskBps)) / 10000n;
  const topTierMax = m.tiers.length ? m.tiers[m.tiers.length - 1].maxValue : 0n;

  async function spin() {
    if (!deployment || !client) return;
    if (!(await ensureToken(deployment.quote, m.address, m.spinPrice))) return;
    const receipt = await run(`Spin · $${fmtUsdc(m.spinPrice, 0)}`, (w) =>
      w({ address: m.address, abi: machineAbi, functionName: "spin", args: [zeroAddress] }),
    );
    if (!receipt) return;
    const [req] = parseEventLogs({ abi: machineAbi, logs: receipt.logs, eventName: "SpinRequested" });
    if (!req) return;
    setResult({ kind: "waiting" });
    let logs = receipt.logs;
    if (deployment.randomnessKind === "mock") {
      const r2 = await run("Reveal (local mock VRF callback)", (w) =>
        w({ address: deployment.randomness, abi: mockRandomnessAbi, functionName: "fulfill", args: [req.args.requestId] }),
      );
      if (!r2) return setResult(null);
      logs = r2.logs;
    } else {
      // Wait for Chainlink VRF to call back.
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const found = await client.getContractEvents({
          address: m.address, abi: machineAbi, fromBlock: receipt.blockNumber, args: { requestId: req.args.requestId },
        });
        if (found.some((e) => e.eventName === "SpinSettled" || e.eventName === "SpinRefunded")) {
          logs = found as never;
          break;
        }
      }
    }
    const settled = parseEventLogs({ abi: machineAbi, logs, eventName: "SpinSettled" })[0];
    if (settled) {
      setResult({ kind: "won", tokenId: settled.args.tokenId, tier: settled.args.tier, value: settled.args.value, earmarkId: settled.args.earmarkId, pity: settled.args.pity });
    } else if (parseEventLogs({ abi: machineAbi, logs, eventName: "SpinRefunded" }).length) {
      setResult({ kind: "refunded" });
    }
  }

  async function exit(r: Extract<Result, { kind: "won" }>) {
    if (!deployment || !m.nft) return;
    if (!(await ensureNft(m.nft, deployment.bidBook))) return;
    const ok = await run(`Sell #${Number(r.tokenId)} at its value`, (w) =>
      w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "fillEarmark", args: [r.earmarkId] }),
    );
    if (ok) setResult(null);
  }

  return (
    <>
      <div className="card swap-card stack sticky">
        <div className="between">
          <div className="tabs">
            <button className="tab active">Spin</button>
          </div>
          <span className="small muted">Chainlink VRF {deployment?.randomnessKind === "mock" ? "(local mock)" : ""}</span>
        </div>
        <div className="panel stack-sm">
          <div className="field-label">Spin price</div>
          <div className="between">
            <span className="amount-input mono" style={{ width: "auto" }}>{fmtUsdc(m.spinPrice, 0)}</span>
            <span className="token-chip"><span className="usdc-icon">$</span>USDC</span>
          </div>
        </div>
        <div className="panel stack-sm">
          <div className="field-label">Expected value of this spin (redeemable)</div>
          <div className="between">
            <span className="amount-input mono" style={{ width: "auto" }}>{fmtUsdc(m.odds.goal)}</span>
            <span className="badge badge-accent">Return {fmtPct(Number(m.odds.goal) / Number(m.spinPrice || 1n))}</span>
          </div>
          <div className="small muted">Measured at bid prices. For 3 days after a win you can sell the NFT to the bid that set its value.</div>
        </div>
        <div className="stack-sm" style={{ padding: "0 4px" }}>
          <div className="kv"><span>Protocol / frontend / creator fee</span><span>{fmtPct(FEE_BPS.protocol / 1e4, 1)} / {fmtPct(FEE_BPS.frontend / 1e4, 1)} / {fmtPct(m.creatorFeeBps / 1e4, 1)}</span></div>
          <div className="kv"><span>Inventory yield / pity pool</span><span>{fmtPct(FEE_BPS.inventory / 1e4, 1)} / {fmtPct(FEE_BPS.pity / 1e4, 1)}</span></div>
          <div className="kv"><span>Reserve · per-prize cap (water level)</span><span>${fmtUsdc(m.totalAssets, 0)} · ${fmtUsdc(cap, 0)}</span></div>
          <div className="stack-sm">
            <div className="bar"><div style={{ width: `${Math.min(100, Number((cap * 100n) / (topTierMax || 1n)))}%` }} /></div>
            <div className="small muted">Legendary unlocks when the per-prize cap reaches ${fmtUsdc((topTierMax * 103n) / 100n, 0)}</div>
          </div>
        </div>
        {address && m.pityThreshold > 0 && (
          <div className="panel stack-sm">
            <div className="between small">
              <span className="muted">Pity: {pity.count}/{m.pityThreshold} spins without {TIER_NAMES[m.pityTier]} or better</span>
              {pity.due ? <span className="badge badge-accent">Next spin is a pity spin</span> : <span className="muted">Pity pool ${fmtUsdc(m.pityPool, 0)}</span>}
            </div>
            <div className="bar"><div style={{ width: `${Math.min(100, (pity.count / m.pityThreshold) * 100)}%` }} /></div>
            {pity.count >= m.pityThreshold && !pity.due && <div className="small warn">The pity pool cannot cover this pity spin yet; it applies automatically once the pool has enough.</div>}
          </div>
        )}
        <button className="btn btn-primary btn-lg" disabled={!address || busy || !m.odds.open} onClick={spin}>
          {!address ? "Connect a wallet first" : !m.odds.open ? "Paused (not enough inventory or reserve)" : busy ? "Processing…" : "Spin"}
        </button>
      </div>

      <Modal open={!!result} onClose={() => setResult(null)} title={result?.kind === "won" ? "You won!" : result?.kind === "refunded" ? "Refunded" : "Revealing"}>
        {result?.kind === "waiting" && (
          <div className="stack" style={{ alignItems: "center", padding: 24 }}>
            <span className="spinner" style={{ width: 40, height: 40, borderWidth: 4 }} />
            <div className="muted">Waiting for the randomness callback…</div>
          </div>
        )}
        {result?.kind === "refunded" && <div className="muted">This spin could not complete (inventory or reserve changed). The spin price was refunded in full.</div>}
        {result?.kind === "won" && (
          <div className="stack">
            <div className="reveal-art">
              <NftArt tokenId={result.tokenId} traits={tokenTraits(collection, result.tokenId)} size="100%" rounded={20} />
            </div>
            <div className="between">
              <div>
                <div className="h3">{collection?.name} #{Number(result.tokenId)}</div>
                <div className="small" style={{ color: TIER_COLORS[result.tier] }}>
                  {TIER_NAMES[result.tier]} {result.pity && <span className="badge badge-accent">Pity triggered</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="small muted">Redeemable value</div>
                <div className="h3 mono">${fmtUsdc(result.value)}</div>
              </div>
            </div>
            <TraitList tokenId={result.tokenId} />
            <div className="grid grid-2">
              <button className="btn" onClick={() => setResult(null)}>Keep</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => exit(result)}>
                Sell ${fmtUsdc((result.value * 99n) / 100n)}
              </button>
            </div>
            <div className="small faint">Sells at the value minus a 1% protocol fee. You can also sell later from the Sell page within 3 days.</div>
          </div>
        )}
      </Modal>
    </>
  );
}

export function MachinePage() {
  const { address } = useParams();
  const { machines, isLoading } = useMachines(address as Address);
  const m = useMemo(() => machines[0], [machines]);
  const pity = usePity(m?.address);
  if (isLoading || !m) {
    return <div className="stack"><Skeleton h={40} w={300} /><Skeleton h={400} /></div>;
  }
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row small muted"><Link to="/">Spin</Link><span>›</span><span>{m.name}</span></div>
      <div className="page-cols">
        <div className="stack" style={{ gap: 20 }}>
          <div className="card card-pad stack">
            <div className="between wrap">
              <div>
                <h1 className="h2">{m.name}</h1>
                <div className="small muted">Creator {short(m.creator)} · Contract {short(m.address)}</div>
              </div>
              {m.odds.open ? <span className="badge badge-ok">● Live</span> : <span className="badge badge-warn">Paused</span>}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
              <Stat label="Target return" value={fmtPct(m.targetRtpBps / 1e4, 0)} hint="Odds solved on chain every spin" />
              <Stat label="Reserve" value={`$${fmtUsdc(m.totalAssets, 0)}`} hint={`Risk factor ${fmtPct(m.riskBps / 1e4, 0)}`} />
              <Stat label="Listed" value={m.tierSizes.reduce((a, b) => a + b, 0)} hint={`${m.listingCount} consigned in total`} />
              <Stat label="Unpaid inventory yield" value={`$${fmtUsdc(m.yieldLiability)}`} hint="1.5% of each spin to listed NFTs" />
              <Stat label="Pity pool" value={`$${fmtUsdc(m.pityPool, 0)}`} hint={m.pityThreshold ? `Triggers after ${m.pityThreshold} spins without Rare` : "Off"} />
            </div>
            <div className="divider" />
            <div className="between">
              <div className="h3">Odds for this spin</div>
              <span className="small muted">{pity.due ? "Pity spin: Rare or better only" : "Live · from inventory and reserve"}</span>
            </div>
            <OddsTable m={m} odds={pity.due && pity.odds ? pity.odds : m.odds} />
          </div>
          <Inventory m={m} />
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <SpinCard m={m} />
          <RecentPulls m={m} />
        </div>
      </div>
    </div>
  );
}
