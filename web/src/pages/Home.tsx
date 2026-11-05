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
        {m.odds.open ? <span className="badge badge-ok">● Live</span> : <span className="badge badge-warn">Paused</span>}
      </div>
      <div>
        <div className="h3">{m.name}</div>
        <div className="small muted">
          {collection?.name ?? "NFT"} · {m.tierSizes.reduce((a, b) => a + b, 0)} listed
        </div>
      </div>
      <div className="grid grid-3" style={{ gap: 8 }}>
        <Stat label="Spin" value={`$${fmtUsdc(m.spinPrice, 0)}`} />
        <Stat label="Return" value={fmtPct(m.targetRtpBps / 10000, 0)} />
        <Stat label="Reserve" value={`$${fmtUsdc(m.totalAssets, 0)}`} />
      </div>
      <div className="stack-sm">
        <div className="between small">
          <span className="muted">{live}/{m.tiers.length} tiers unlocked</span>
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
          Spinning is trading. <span className="accent">Listing is market making.</span>
        </h1>
        <p>
          Every NFT is valued by a bid backed by locked funds. What you see is what you can redeem. Sellers only set a floor; the market sets the price.
        </p>
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <a href="#machines" className="btn btn-primary">Start spinning</a>
          <Link to="/sell" className="btn">List your NFTs</Link>
        </div>
      </section>

      {deployment && (
        <section className="card card-pad">
          <div className="grid grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Stat label="Total reserve" value={`$${fmtUsdc(tvl, 0)}`} />
            <Stat label="Machines" value={machines.length} />
            <Stat label="Active bids" value={bids.filter((b) => b.eligible).length} hint={`${bids.length} total`} />
            <Stat label="Pool orders" value={orders.filter((o) => o.active).length} />
            <Stat label="Odds listings" value={listings.filter((l) => l.active).length} />
          </div>
        </section>
      )}

      <section id="machines" className="stack">
        <div className="between">
          <h2 className="h2">Machines</h2>
          <Link to="/create" className="btn btn-sm">+ Create a machine</Link>
        </div>
        {isLoading ? (
          <div className="grid grid-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {[0, 1].map((i) => <Skeleton key={i} h={280} />)}
          </div>
        ) : machines.length === 0 ? (
          <div className="card empty">No machines on this chain yet.</div>
        ) : (
          <div className="grid grid-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {machines.map((m) => <MachineCard key={m.address} m={m} />)}
          </div>
        )}
      </section>

      <section className="grid grid-3">
        {[
          ["Value = committed bids", "The floor comes from market-making curves; trait premiums come from trait bids backed by locked funds. After a win you can sell at that value at any time."],
          ["Return lock", "Creators set the odds shape and a target return. The contract re-solves the odds for every spin from live inventory, so the expected value equals the target."],
          ["Sellers only set a floor", "Bids set the price; your floor only decides whether you sell. Asking too much does not hurt players, it just does not fill."],
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
