import { useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { parseEventLogs, zeroAddress } from "viem";
import { mockRandomnessAbi, oddsAbi } from "../generated/abis";
import { bestBidsFor, useBids, useOddsListings, type OddsListing } from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { NftArt } from "../components/NftArt";
import { TraitList } from "../components/NftTile";
import { Empty, Modal, Stat } from "../components/ui";
import { fmtPct, fmtUsdc, short } from "../lib/format";
import { tokenTraits } from "../lib/traits";

const FEE_BPS = 600n;

function OddsCard({ l, maxAsk, onResult }: { l: OddsListing; maxAsk?: bigint; onResult: (won: boolean, l: OddsListing) => void }) {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { bids } = useBids();
  const client = usePublicClient();
  const { run, busy } = useTx();
  const { ensureToken } = useApprovals();
  const [q, setQ] = useState(10);
  const stake = (l.ask * BigInt(q * 100)) / 10000n;
  const total = stake + (stake * FEE_BPS) / 10000n;
  const { fill } = bestBidsFor(bids, collection, l.nft, Number(l.tokenId));
  const tooBig = maxAsk !== undefined && l.ask > maxAsk;

  async function buy() {
    if (!deployment || !client) return;
    if (!(await ensureToken(deployment.quote, deployment.odds, total))) return;
    const r = await run(`Buy ${q}% odds · $${fmtUsdc(total)}`, (w) =>
      w({ address: deployment.odds, abi: oddsAbi, functionName: "buyOdds", args: [BigInt(l.id), q * 100, zeroAddress] }),
    );
    if (!r) return;
    const [req] = parseEventLogs({ abi: oddsAbi, logs: r.logs, eventName: "OddsRequested" });
    let logs = r.logs;
    if (deployment.randomnessKind === "mock") {
      const r2 = await run("Reveal (local mock VRF callback)", (w) =>
        w({ address: deployment.randomness, abi: mockRandomnessAbi, functionName: "fulfill", args: [req.args.requestId] }),
      );
      if (!r2) return;
      logs = r2.logs;
    } else {
      for (let i = 0; i < 100; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const found = await client.getContractEvents({ address: deployment.odds, abi: oddsAbi, eventName: "OddsSettled", args: { requestId: req.args.requestId }, fromBlock: r.blockNumber });
        if (found.length) { logs = found as never; break; }
      }
    }
    const [settled] = parseEventLogs({ abi: oddsAbi, logs, eventName: "OddsSettled" });
    if (settled) onResult(settled.args.won, l);
  }

  return (
    <div className="card stack" style={{ padding: 12 }}>
      <NftArt tokenId={l.tokenId} traits={tokenTraits(collection, l.tokenId)} size="100%" rounded={14} />
      <div className="between">
        <div style={{ fontWeight: 535 }}>{collection?.name} #{Number(l.tokenId)}</div>
        {l.pending && <span className="badge badge-warn">Revealing</span>}
      </div>
      <TraitList tokenId={l.tokenId} />
      <div className="grid grid-2" style={{ gap: 8 }}>
        <Stat label="Seller ask" value={`$${fmtUsdc(l.ask, 0)}`} />
        <Stat label="Best trait bid" value={fill ? `$${fmtUsdc(fill.price, 0)}` : "—"} />
      </div>
      <div className="panel stack-sm">
        <div className="between"><span className="field-label">Win chance</span><span className="mono" style={{ fontWeight: 600 }}>{q}%</span></div>
        <input type="range" min={1} max={50} value={q} onChange={(e) => setQ(Number(e.target.value))} />
        <div className="between small muted"><span>Cost</span><span className="mono">${fmtUsdc(total)}</span></div>
      </div>
      <button className="btn btn-primary" disabled={!address || busy || l.pending || tooBig} onClick={buy}>
        {tooBig ? "Vault too small" : `Try your luck · ${q}%`}
      </button>
      <div className="small faint">Seller {short(l.seller)} · on a win the seller gets the ask + 1.5%</div>
    </div>
  );
}

export function OddsPage() {
  const { listings, maxAsk, totalAssets } = useOddsListings();
  const { collection } = useDeployment();
  const [result, setResult] = useState<{ won: boolean; l: OddsListing } | null>(null);
  const active = listings.filter((l) => l.active);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="between wrap">
        <div>
          <h1 className="h2">Odds</h1>
          <div className="muted">For rare NFTs no bid can price. Pay 1–50% of the ask for the same chance to win it. You see exactly which NFT it is, so if the ask is too high, just do not buy.</div>
        </div>
        <div className="card row" style={{ gap: 24, padding: "12px 20px" }}>
          <Stat label="Vault" value={`$${fmtUsdc(totalAssets, 0)}`} />
          <Stat label="Max ask per NFT" value={`$${fmtUsdc(maxAsk, 0)}`} />
          <Stat label="Fee" value={fmtPct(Number(FEE_BPS) / 1e4, 0)} />
        </div>
      </div>
      {active.length === 0 ? (
        <div className="card"><Empty>No NFTs listed yet. List one from the Sell page with "Sell by odds".</Empty></div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {active.map((l) => <OddsCard key={l.id} l={l} maxAsk={maxAsk} onResult={(won, x) => setResult({ won, l: x })} />)}
        </div>
      )}
      <Modal open={!!result} onClose={() => setResult(null)} title={result?.won ? "You won!" : "Not this time"}>
        {result && (
          <div className="stack">
            <div className={result.won ? "reveal-art" : ""} style={{ opacity: result.won ? 1 : 0.4, filter: result.won ? undefined : "grayscale(1)" }}>
              <NftArt tokenId={result.l.tokenId} traits={tokenTraits(collection, result.l.tokenId)} size="100%" rounded={20} />
            </div>
            <div className="muted">
              {result.won
                ? `${collection?.name} #${Number(result.l.tokenId)} is now in your wallet.`
                : "This NFT is still listed. You can try again."}
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => setResult(null)}>OK</button>
          </div>
        )}
      </Modal>
    </div>
  );
}
