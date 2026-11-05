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
  steady: { label: "稳健", probs: [6886, 2141, 730, 214, 29], desc: "中档卡多，约每 5 抽回本 1 次" },
  standard: { label: "标准", probs: [7198, 1804, 702, 271, 25], desc: "接近 v1 示例机器" },
  chase: { label: "追梦", probs: [8038, 1195, 498, 199, 70], desc: "传说概率接近 3 倍，普通卡更多" },
};
// Tier bands as multiples of the single-pull price: 0.2-0.6 / 0.6-1.5 / 1.5-4 / 4-12 / 12-60.
const BANDS = [[0.2, 0.6], [0.6, 1.5], [1.5, 4], [4, 12], [12, 60]];
const DENOMS = ["25", "50", "100", "250", "1000"];

export function Create() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { run, busy } = useTx();
  const navigate = useNavigate();
  const [name, setName] = useState("我的 Pod Apes 机器");
  const [price, setPrice] = useState("50");
  const [preset, setPreset] = useState("standard");
  const [rtp, setRtp] = useState(89);
  const [creatorFee, setCreatorFee] = useState(2.5);
  const [risk, setRisk] = useState(25);

  const p = parseUsdc(price);
  const tiers = BANDS.map(([lo, hi], i) => ({
    minValue: (p * BigInt(Math.round(lo * 100))) / 100n,
    maxValue: (p * BigInt(Math.round(hi * 100))) / 100n,
    baseProbBps: PRESETS[preset].probs[i],
  }));

  async function submit() {
    if (!deployment?.demoCollection) return;
    const r = await run(`创建机器「${name}」`, (w) =>
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
        <h1 className="h2">开一台机器</h1>
        <div className="muted">不囤货、不垫钱。你定主题、概率形状和返还率，合约保证每一抽的期望值恰好等于目标；持有人把 NFT 挂进来，LP 提供储备，你按流水分成。</div>
      </div>
      <div className="page-cols">
        <div className="card card-pad stack">
          <div className="stack-sm"><div className="field-label">机器名称</div><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="stack-sm">
            <div className="field-label">系列</div>
            <div className="input muted">{collection?.name ?? "—"}（已在注册表登记特征快照）</div>
          </div>
          <div className="stack-sm">
            <div className="field-label">单抽价（标准面额）</div>
            <div className="segmented" style={{ alignSelf: "flex-start" }}>
              {DENOMS.map((d) => <button key={d} className={price === d ? "active" : ""} onClick={() => setPrice(d)}>${d}</button>)}
            </div>
          </div>
          <div className="stack-sm">
            <div className="field-label">概率形状</div>
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
            <div className="between"><span className="field-label">目标返还率</span><span className="mono">{rtp}%</span></div>
            <input type="range" min={85} max={97} step={0.5} value={rtp} onChange={(e) => setRtp(Number(e.target.value))} />
          </div>
          <div className="grid grid-2">
            <div className="stack-sm">
              <div className="between"><span className="field-label">主理人分成</span><span className="mono">{creatorFee}%</span></div>
              <input type="range" min={0} max={3} step={0.25} value={creatorFee} onChange={(e) => setCreatorFee(Number(e.target.value))} />
            </div>
            <div className="stack-sm">
              <div className="between"><span className="field-label">风险系数</span><span className="mono">{risk}%</span></div>
              <input type="range" min={5} max={25} step={1} value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
            </div>
          </div>
          <div className="small faint">风险系数：单件奖品结算额不超过储备的这个比例。只有种子储备时建议 10%。</div>
        </div>
        <div className="card swap-card stack sticky">
          <div className="h3">预览</div>
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
          <div className="kv"><span>每抽期望价值</span><span>${fmtUsdc((p * BigInt(Math.round(rtp * 100))) / 10000n)}</span></div>
          <div className="kv"><span>每抽主理人收入</span><span>${fmtUsdc((p * BigInt(Math.round(creatorFee * 100))) / 10000n)}</span></div>
          <div className="kv"><span>解锁传说档所需储备</span><span>${fmtUsdc((((tiers[4].maxValue * 103n) / 100n) * 100n) / BigInt(risk || 1), 0)}</span></div>
          <button className="btn btn-primary btn-lg" disabled={!address || busy || !deployment?.demoCollection || p === 0n} onClick={submit}>创建机器</button>
          <div className="small faint">参数创建后不可修改。合约会校验：档位不重叠、档内上下限比 ≤ 3（传说 ≤ 5）、最高奖品 ≤ 60 倍单抽价、返还率 85–97%。</div>
        </div>
      </div>
    </div>
  );
}
