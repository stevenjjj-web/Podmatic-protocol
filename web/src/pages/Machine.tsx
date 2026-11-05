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
                  ${fmtUsdc(t.minValue, 0)}–{fmtUsdc(t.maxValue, 0)} · 在架 {m.tierSizes[k]}
                </span>
                <span>{live ? `均值 $${fmtUsdc(odds.evs[k] ?? 0n)}` : !odds.live[k] && m.tierSizes[k] ? "水位未到" : m.tierSizes[k] ? "本抽不出" : "缺货"}</span>
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
        <div className="h3">奖池里有什么</div>
        <div className="tabs wrap">
          {m.tiers.map((_, k) => (
            <button key={k} className={`tab ${tier === k ? "active" : ""}`} onClick={() => setTier(k)}>
              {TIER_NAMES[k]} {m.tierSizes[k]}
            </button>
          ))}
        </div>
      </div>
      {listingIds.length === 0 ? (
        <Empty>这一档现在没有可抽的 NFT。</Empty>
      ) : (
        <div className="grid grid-nft">
          {(rows.data ?? []).map((r, i) => {
            const l = r.result as { tokenId: bigint; value: bigint } | undefined;
            if (!l) return <Skeleton key={i} h={200} />;
            return (
              <NftTile key={String(listingIds[i])} tokenId={l.tokenId}>
                <div className="small muted">估值 ${fmtUsdc(l.value)}</div>
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
      <div className="h3">最近抽中</div>
      {pulls.length === 0 ? (
        <Empty>还没有人抽过。</Empty>
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
    const receipt = await run(`抽一次 · $${fmtUsdc(m.spinPrice, 0)}`, (w) =>
      w({ address: m.address, abi: machineAbi, functionName: "spin", args: [zeroAddress] }),
    );
    if (!receipt) return;
    const [req] = parseEventLogs({ abi: machineAbi, logs: receipt.logs, eventName: "SpinRequested" });
    if (!req) return;
    setResult({ kind: "waiting" });
    let logs = receipt.logs;
    if (deployment.randomnessKind === "mock") {
      const r2 = await run("揭晓结果（本地模拟 VRF 回调）", (w) =>
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
    const ok = await run(`按估值卖出 #${Number(r.tokenId)}`, (w) =>
      w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "fillEarmark", args: [r.earmarkId] }),
    );
    if (ok) setResult(null);
  }

  return (
    <>
      <div className="card swap-card stack sticky">
        <div className="between">
          <div className="tabs">
            <button className="tab active">抽卡</button>
          </div>
          <span className="small muted">Chainlink VRF {deployment?.randomnessKind === "mock" ? "（本地模拟）" : ""}</span>
        </div>
        <div className="panel stack-sm">
          <div className="field-label">单抽价格</div>
          <div className="between">
            <span className="amount-input mono" style={{ width: "auto" }}>{fmtUsdc(m.spinPrice, 0)}</span>
            <span className="token-chip"><span className="usdc-icon">$</span>USDC</span>
          </div>
        </div>
        <div className="panel stack-sm">
          <div className="field-label">这一抽的期望价值（可兑现）</div>
          <div className="between">
            <span className="amount-input mono" style={{ width: "auto" }}>{fmtUsdc(m.odds.goal)}</span>
            <span className="badge badge-accent">返还率 {fmtPct(Number(m.odds.goal) / Number(m.spinPrice || 1n))}</span>
          </div>
          <div className="small muted">按买单价计。抽中后 3 天内可随时按估值卖给定义估值的那笔买单。</div>
        </div>
        <div className="stack-sm" style={{ padding: "0 4px" }}>
          <div className="kv"><span>协议 / 前端 / 主理人费</span><span>{fmtPct(FEE_BPS.protocol / 1e4, 1)} / {fmtPct(FEE_BPS.frontend / 1e4, 1)} / {fmtPct(m.creatorFeeBps / 1e4, 1)}</span></div>
          <div className="kv"><span>库存收益 / 保底池</span><span>{fmtPct(FEE_BPS.inventory / 1e4, 1)} / {fmtPct(FEE_BPS.pity / 1e4, 1)}</span></div>
          <div className="kv"><span>储备 · 单件上限（水位）</span><span>${fmtUsdc(m.totalAssets, 0)} · ${fmtUsdc(cap, 0)}</span></div>
          <div className="stack-sm">
            <div className="bar"><div style={{ width: `${Math.min(100, Number((cap * 100n) / (topTierMax || 1n)))}%` }} /></div>
            <div className="small muted">传说档解锁需要单件上限 ≥ ${fmtUsdc((topTierMax * 103n) / 100n, 0)}</div>
          </div>
        </div>
        {address && m.pityThreshold > 0 && (
          <div className="panel stack-sm">
            <div className="between small">
              <span className="muted">保底：连续 {pity.count}/{m.pityThreshold} 抽未出{TIER_NAMES[m.pityTier]}及以上</span>
              {pity.due ? <span className="badge badge-accent">下一抽保底</span> : <span className="muted">保底池 ${fmtUsdc(m.pityPool, 0)}</span>}
            </div>
            <div className="bar"><div style={{ width: `${Math.min(100, (pity.count / m.pityThreshold) * 100)}%` }} /></div>
            {pity.count >= m.pityThreshold && !pity.due && <div className="small warn">保底池暂时不够支付这次保底，攒够后自动生效。</div>}
          </div>
        )}
        <button className="btn btn-primary btn-lg" disabled={!address || busy || !m.odds.open} onClick={spin}>
          {!address ? "先连接钱包" : !m.odds.open ? "机器暂停（库存或水位不足）" : busy ? "处理中…" : "抽一次"}
        </button>
      </div>

      <Modal open={!!result} onClose={() => setResult(null)} title={result?.kind === "won" ? "抽中了！" : result?.kind === "refunded" ? "已退款" : "开奖中"}>
        {result?.kind === "waiting" && (
          <div className="stack" style={{ alignItems: "center", padding: 24 }}>
            <span className="spinner" style={{ width: 40, height: 40, borderWidth: 4 }} />
            <div className="muted">等待随机数回调…</div>
          </div>
        )}
        {result?.kind === "refunded" && <div className="muted">这一抽没能完成（库存或水位变化），单抽价已全额退回。</div>}
        {result?.kind === "won" && (
          <div className="stack">
            <div className="reveal-art">
              <NftArt tokenId={result.tokenId} traits={tokenTraits(collection, result.tokenId)} size="100%" rounded={20} />
            </div>
            <div className="between">
              <div>
                <div className="h3">{collection?.name} #{Number(result.tokenId)}</div>
                <div className="small" style={{ color: TIER_COLORS[result.tier] }}>
                  {TIER_NAMES[result.tier]} {result.pity && <span className="badge badge-accent">保底触发</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="small muted">可兑现估值</div>
                <div className="h3 mono">${fmtUsdc(result.value)}</div>
              </div>
            </div>
            <TraitList tokenId={result.tokenId} />
            <div className="grid grid-2">
              <button className="btn" onClick={() => setResult(null)}>留着</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => exit(result)}>
                卖出 ${fmtUsdc((result.value * 99n) / 100n)}
              </button>
            </div>
            <div className="small faint">卖出按估值成交，扣 1% 协议费；也可以 3 天内在“挂卡”页再卖。</div>
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
      <div className="row small muted"><Link to="/">抽卡</Link><span>›</span><span>{m.name}</span></div>
      <div className="page-cols">
        <div className="stack" style={{ gap: 20 }}>
          <div className="card card-pad stack">
            <div className="between wrap">
              <div>
                <h1 className="h2">{m.name}</h1>
                <div className="small muted">主理人 {short(m.creator)} · 合约 {short(m.address)}</div>
              </div>
              {m.odds.open ? <span className="badge badge-ok">● 可抽</span> : <span className="badge badge-warn">暂停</span>}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
              <Stat label="目标返还率" value={fmtPct(m.targetRtpBps / 1e4, 0)} hint="合约每抽求解概率" />
              <Stat label="储备" value={`$${fmtUsdc(m.totalAssets, 0)}`} hint={`风险系数 ${fmtPct(m.riskBps / 1e4, 0)}`} />
              <Stat label="在架" value={m.tierSizes.reduce((a, b) => a + b, 0)} hint={`累计寄售 ${m.listingCount}`} />
              <Stat label="待付库存收益" value={`$${fmtUsdc(m.yieldLiability)}`} hint="每抽 1.5% 分给在架寄售卡" />
              <Stat label="保底池" value={`$${fmtUsdc(m.pityPool, 0)}`} hint={m.pityThreshold ? `连续 ${m.pityThreshold} 抽未出稀有触发` : "未开启"} />
            </div>
            <div className="divider" />
            <div className="between">
              <div className="h3">这一抽的概率</div>
              <span className="small muted">{pity.due ? "保底抽：只出稀有及以上" : "实时 · 按库存与水位"}</span>
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
