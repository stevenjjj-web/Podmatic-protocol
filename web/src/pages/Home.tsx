import { Link } from "react-router-dom";
import { useMachines, useBids, useFloorOrders, useOddsListings, type MachineInfo } from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { NftArt } from "../components/NftArt";
import { Skeleton, Stat, TIER_COLORS, TIER_NAMES } from "../components/ui";
import { fmtPct, fmtUsdc, prob } from "../lib/format";
import { tokenTraits } from "../lib/traits";

function showcaseTokens(collection: ReturnType<typeof useDeployment>["collection"]): number[] {
  if (!collection) return [1, 2, 3];
  const score = (t: { traits: Record<string, string> }) =>
    (t.traits.Fur === "Gold" ? 4 : 0) + (t.traits.Hat === "Halo" ? 3 : t.traits.Hat === "Crown" ? 2 : 0) + (t.traits.Eyes === "Laser" ? 1 : 0);
  return [...collection.tokens].sort((a, b) => score(b) - score(a)).slice(0, 3).map((t) => t.tokenId);
}

function MachineCard({ m }: { m: MachineInfo }) {
  const { collection } = useDeployment();
  const live = m.odds.live.filter(Boolean).length;
  const top = m.odds.live.lastIndexOf(true);
  const topProb = top >= 0 ? prob(m.odds.probs[top]) : 0;
  return (
    <Link to={`/machine/${m.address}`} className="card card-pad machine-card">
      <div className="between">
        <div className="art-stack">
          {showcaseTokens(collection).map((id) => (
            <NftArt key={id} tokenId={id} traits={tokenTraits(collection, id)} size={56} rounded={11} />
          ))}
        </div>
        {m.odds.open ? <span className="badge badge-ok">● 可抽</span> : <span className="badge badge-warn">暂停</span>}
      </div>
      <div>
        <div className="h3">{m.name}</div>
        <div className="small muted">
          {collection?.name ?? "NFT"} · 在架 {m.tierSizes.reduce((a, b) => a + b, 0)} 件
        </div>
      </div>
      <div className="grid grid-3" style={{ gap: 8 }}>
        <Stat label="单抽" value={`$${fmtUsdc(m.spinPrice, 0)}`} />
        <Stat label="返还率" value={fmtPct(m.targetRtpBps / 10000, 0)} />
        <Stat label="储备" value={`$${fmtUsdc(m.totalAssets, 0)}`} />
      </div>
      <div className="stack-sm">
        <div className="between small">
          <span className="muted">已解锁 {live}/{m.tiers.length} 档</span>
          {top >= 0 && (
            <span style={{ color: TIER_COLORS[top] }}>
              {TIER_NAMES[top]} {fmtPct(topProb)}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 3 }}>
          {m.tiers.map((_, k) => (
            <div key={k} style={{ flex: 1, height: 6, borderRadius: 4, background: m.odds.live[k] ? TIER_COLORS[k] : "var(--surface3)" }} />
          ))}
        </div>
      </div>
    </Link>
  );
}

export function Home() {
  const { deployment } = useDeployment();
  const { machines, isLoading } = useMachines();
  const { bids } = useBids();
  const { orders } = useFloorOrders();
  const { listings, totalAssets } = useOddsListings();
  const tvl = machines.reduce((a, m) => a + m.totalAssets, 0n) + (totalAssets ?? 0n);

  return (
    <div className="stack" style={{ gap: 28 }}>
      <section className="hero">
        <span className="badge badge-accent">Ethereum · Base</span>
        <h1 className="h1">
          抽卡是成交，<span className="accent">挂卡是做市</span>
        </h1>
        <p>
          每个 NFT 的估值都来自真金白银锁定的买单。展示多少，就能兑现多少；卖家只给底价，成交价交给市场。
        </p>
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <a href="#machines" className="btn btn-primary">开始抽卡</a>
          <Link to="/sell" className="btn">把 NFT 挂进来</Link>
        </div>
      </section>

      {deployment && (
        <section className="card card-pad">
          <div className="grid grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Stat label="总储备" value={`$${fmtUsdc(tvl, 0)}`} />
            <Stat label="抽卡机器" value={machines.length} />
            <Stat label="有效买单" value={bids.filter((b) => b.eligible).length} hint={`共 ${bids.length} 笔`} />
            <Stat label="做市订单" value={orders.filter((o) => o.active).length} />
            <Stat label="概率买挂单" value={listings.filter((l) => l.active).length} />
          </div>
        </section>
      )}

      <section id="machines" className="stack">
        <div className="between">
          <h2 className="h2">抽卡机器</h2>
          <Link to="/create" className="btn btn-sm">+ 开一台机器</Link>
        </div>
        {isLoading ? (
          <div className="grid grid-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {[0, 1].map((i) => <Skeleton key={i} h={280} />)}
          </div>
        ) : machines.length === 0 ? (
          <div className="card empty">这条链上还没有机器。</div>
        ) : (
          <div className="grid grid-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {machines.map((m) => <MachineCard key={m.address} m={m} />)}
          </div>
        )}
      </section>

      <section className="grid grid-3">
        {[
          ["估值 = 承诺买单", "地板价来自做市曲线，特征溢价来自锁定资金的特征买单。抽中后可以随时按估值卖给那笔买单。"],
          ["返还率锁定", "主理人定概率形状和目标返还率，合约每一抽按在架库存重新求解概率，期望值恰好等于目标。"],
          ["卖家只给底价", "成交价由买单决定，底价只决定卖不卖。想卖高价不会伤害玩家，只是等不到成交。"],
        ].map(([t, d]) => (
          <div key={t} className="card card-pad stack-sm">
            <div className="h3">{t}</div>
            <div className="muted small">{d}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
