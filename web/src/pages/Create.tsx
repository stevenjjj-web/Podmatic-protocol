import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { parseEventLogs } from "viem";
import { factoryAbi } from "../generated/abis";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { TIER_COLORS, TIER_NAMES } from "../components/ui";
import { fmtPct, fmtUsdc, parseUsdc } from "../lib/format";

// Presets from docs/podmatic-v2-design.md section 4.4 (bps, sum 10000).
const PRESETS: Record<string, { label: string; probs: number[]; desc: string }> = {
  steady: { label: "Steady", probs: [6886, 2141, 730, 214, 29], desc: "More mid-tier prizes; about 1 in 5 spins breaks even" },
  standard: { label: "Standard", probs: [7198, 1804, 702, 271, 25], desc: "Close to the v1 example machine" },
  chase: { label: "Chase", probs: [8038, 1195, 498, 199, 70], desc: "Nearly 3x the legendary odds, more commons" },
};
// Tier bands as multiples of the single-pull price: 0.2-0.6 / 0.6-1.5 / 1.5-4 / 4-12 / 12-60.
const BANDS = [[0.2, 0.6], [0.6, 1.5], [1.5, 4], [4, 12], [12, 60]];
const DENOMS = ["25", "50", "100", "250", "1000"];

export function Create() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { run, busy } = useTx();
  const navigate = useNavigate();
  const [name, setName] = useState("My Pod Apes machine");
  const [price, setPrice] = useState("50");
  const [preset, setPreset] = useState("standard");
  const [rtp, setRtp] = useState(89);
  const [creatorFee, setCreatorFee] = useState(2.5);
  const [risk, setRisk] = useState(25);
  const [pity, setPity] = useState(40);

  const p = parseUsdc(price);
  const tiers = BANDS.map(([lo, hi], i) => ({
    minValue: (p * BigInt(Math.round(lo * 100))) / 100n,
    maxValue: (p * BigInt(Math.round(hi * 100))) / 100n,
    baseProbBps: PRESETS[preset].probs[i],
  }));

  async function submit() {
    if (!deployment?.demoCollection) return;
    const r = await run(`Create machine "${name}"`, (w) =>
      w({
        address: deployment.factory,
        abi: factoryAbi,
        functionName: "createMachine",
        args: [{
          nft: deployment.demoCollection!,
          spinPrice: p,
          targetRtpBps: Math.round(rtp * 100),
          creatorFeeBps: Math.round(creatorFee * 100),
          riskBps: Math.round(risk * 100),
          pityThreshold: pity,
          tiers,
          name,
        }],
      }),
    );
    if (!r) return;
    const [ev] = parseEventLogs({ abi: factoryAbi, logs: r.logs, eventName: "MachineCreated" });
    if (ev) navigate(`/machine/${ev.args.machine}`);
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 className="h2">Create a machine</h1>
        <div className="muted">No inventory, no upfront capital. You set the theme, odds shape and return; the contract keeps every spin's expected value at the target. Holders list NFTs, LPs fund the reserve, and you earn a share of flow.</div>
      </div>
      <div className="page-cols">
        <div className="card card-pad stack">
          <div className="stack-sm"><div className="field-label">Machine name</div><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="stack-sm">
            <div className="field-label">Collection</div>
            <div className="input muted">{collection?.name ?? "—"} (trait snapshot registered)</div>
          </div>
          <div className="stack-sm">
            <div className="field-label">Spin price (standard denominations)</div>
            <div className="segmented" style={{ alignSelf: "flex-start" }}>
              {DENOMS.map((d) => <button key={d} className={price === d ? "active" : ""} onClick={() => setPrice(d)}>${d}</button>)}
            </div>
          </div>
          <div className="stack-sm">
            <div className="field-label">Odds shape</div>
            <div className="grid grid-3" style={{ gap: 8 }}>
              {Object.entries(PRESETS).map(([k, v]) => (
                <button key={k} className={`panel stack-sm ${preset === k ? "selected-panel" : ""}`}
                  style={{ textAlign: "left", cursor: "pointer", border: preset === k ? "1px solid var(--accent1)" : undefined, color: "inherit" }}
                  onClick={() => setPreset(k)}>
                  <span style={{ fontWeight: 600 }}>{v.label}</span>
                  <span className="small muted">{v.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="stack-sm">
            <div className="between"><span className="field-label">Target return</span><span className="mono">{rtp}%</span></div>
            <input type="range" min={85} max={97} step={0.5} value={rtp} onChange={(e) => setRtp(Number(e.target.value))} />
          </div>
          <div className="grid grid-2">
            <div className="stack-sm">
              <div className="between"><span className="field-label">Creator fee</span><span className="mono">{creatorFee}%</span></div>
              <input type="range" min={0} max={3} step={0.25} value={creatorFee} onChange={(e) => setCreatorFee(Number(e.target.value))} />
            </div>
            <div className="stack-sm">
              <div className="between"><span className="field-label">Risk factor</span><span className="mono">{risk}%</span></div>
              <input type="range" min={5} max={25} step={1} value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
            </div>
          </div>
          <div className="small faint">Risk factor: no single prize may settle for more than this share of the reserve. Use 10% when the reserve is only a seed.</div>
          <div className="stack-sm">
            <div className="between"><span className="field-label">Pity threshold</span><span className="mono">{pity === 0 ? "Off" : `${pity} spins`}</span></div>
            <input type="range" min={0} max={100} step={5} value={pity} onChange={(e) => { const v = Number(e.target.value); setPity(v > 0 && v < 20 ? 20 : v); }} />
            <div className="small faint">After this many spins in a row without Rare or better, the next spin draws only from Rare and up; the pity pool (1% of each spin) pays the extra cost. 40 is a good default; you can pre-fund the pool with fundPity after launch.</div>
          </div>
        </div>
        <div className="card swap-card stack sticky">
          <div className="h3">Preview</div>
          <div className="stack-sm">
            {tiers.map((t, i) => (
              <div key={i} className="between small">
                <span className="row"><span className="tier-dot" style={{ background: TIER_COLORS[i] }} />{TIER_NAMES[i]}</span>
                <span className="muted mono">${fmtUsdc(t.minValue, 0)}–{fmtUsdc(t.maxValue, 0)}</span>
                <span className="mono">{fmtPct(t.baseProbBps / 1e4)}</span>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="kv"><span>Expected value per spin</span><span>${fmtUsdc((p * BigInt(Math.round(rtp * 100))) / 10000n)}</span></div>
          <div className="kv"><span>Creator income per spin</span><span>${fmtUsdc((p * BigInt(Math.round(creatorFee * 100))) / 10000n)}</span></div>
          <div className="kv"><span>Reserve needed to unlock Legendary</span><span>${fmtUsdc((((tiers[4].maxValue * 103n) / 100n) * 100n) / BigInt(risk || 1), 0)}</span></div>
          <button className="btn btn-primary btn-lg" disabled={!address || busy || !deployment?.demoCollection || p === 0n} onClick={submit}>Create machine</button>
          <div className="small faint">Parameters cannot be changed after creation. The contract checks: tiers do not overlap, each band spans at most 3x (Legendary 5x), the top prize is at most 60x the spin price, and the return is 85–97%.</div>
        </div>
      </div>
    </div>
  );
}
