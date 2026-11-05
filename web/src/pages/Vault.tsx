import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { machineAbi } from "../generated/abis";
import { useMachines, useOddsListings } from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { useChainTime } from "../hooks/useEvents";
import { AmountPanel, Modal, Stat } from "../components/ui";
import { fmtDuration, fmtUsdc, parseUsdc } from "../lib/format";

type VaultRow = { address: Address; name: string; kind: string; tvl: bigint; note: string };

// Machine and OddsMarket share ReserveVault, so the machine ABI covers both for LP functions.
const vaultAbi = machineAbi;

function useVaultPosition(vault: Address) {
  const { address } = useAccount();
  const q = useReadContracts({
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "sharesOf", args: address ? [address] : undefined },
      { address: vault, abi: vaultAbi, functionName: "withdrawRequests", args: address ? [address] : undefined },
    ],
    query: { enabled: !!address, refetchInterval: 4000 },
  });
  const shares = (q.data?.[0]?.result as bigint | undefined) ?? 0n;
  const req = q.data?.[1]?.result as readonly [bigint, bigint] | undefined;
  const conv = useReadContracts({
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] },
      { address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [req?.[0] ?? 0n] },
    ],
    query: { enabled: !!address, refetchInterval: 4000 },
  });
  return {
    shares,
    assets: (conv.data?.[0]?.result as bigint | undefined) ?? 0n,
    queuedShares: req?.[0] ?? 0n,
    queuedAssets: (conv.data?.[1]?.result as bigint | undefined) ?? 0n,
    unlockAt: req?.[1] ?? 0n,
  };
}

function VaultLine({ v, onManage }: { v: VaultRow; onManage: (v: VaultRow) => void }) {
  const p = useVaultPosition(v.address);
  return (
    <tr>
      <td><div style={{ fontWeight: 535 }}>{v.name}</div><div className="small muted">{v.kind}</div></td>
      <td className="mono">${fmtUsdc(v.tvl, 0)}</td>
      <td className="small muted">{v.note}</td>
      <td className="mono">{p.assets ? `$${fmtUsdc(p.assets)}` : "—"}</td>
      <td className="mono">{p.queuedShares ? `$${fmtUsdc(p.queuedAssets)}` : "—"}</td>
      <td><button className="btn btn-sm btn-soft" onClick={() => onManage(v)}>管理</button></td>
    </tr>
  );
}

function Manage({ v, onClose }: { v: VaultRow; onClose: () => void }) {
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const { run, busy } = useTx();
  const { ensureToken } = useApprovals();
  const now = useChainTime();
  const p = useVaultPosition(v.address);
  const [amount, setAmount] = useState("");
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const value = parseUsdc(amount);
  const sharesToQueue = p.assets > 0n ? (p.shares * (value > p.assets ? p.assets : value)) / p.assets : 0n;
  const unlocked = now !== undefined && p.queuedShares > 0n && now >= p.unlockAt;

  return (
    <div className="stack">
      <div className="grid grid-2">
        <Stat label="我的仓位" value={`$${fmtUsdc(p.assets)}`} />
        <Stat label="排队中" value={`$${fmtUsdc(p.queuedAssets)}`} hint={p.queuedShares ? (unlocked ? "可领取" : `还需 ${fmtDuration(Number(p.unlockAt - (now ?? 0n)))}`) : undefined} />
      </div>
      <div className="tabs">
        <button className={`tab ${tab === "deposit" ? "active" : ""}`} onClick={() => setTab("deposit")}>存入</button>
        <button className={`tab ${tab === "withdraw" ? "active" : ""}`} onClick={() => setTab("withdraw")}>取出</button>
      </div>
      <AmountPanel label={tab === "deposit" ? "存入 USDC" : "取出 USDC（按当前净值折算份额）"} value={amount} onChange={setAmount} />
      {tab === "deposit" ? (
        <button className="btn btn-primary btn-lg" disabled={!address || busy || value === 0n}
          onClick={async () => {
            if (!deployment || !(await ensureToken(deployment.quote, v.address, value))) return;
            await run(`存入 ${v.name} $${fmtUsdc(value)}`, (w) => w({ address: v.address, abi: vaultAbi, functionName: "deposit", args: [value] }));
            setAmount("");
          }}>
          存入
        </button>
      ) : (
        <div className="stack">
          <button className="btn btn-primary btn-lg" disabled={!address || busy || sharesToQueue === 0n}
            onClick={() => run("申请取出（排队 1 天）", (w) => w({ address: v.address, abi: vaultAbi, functionName: "requestWithdraw", args: [sharesToQueue] }))}>
            申请取出
          </button>
          <button className="btn btn-lg" disabled={!address || busy || !unlocked}
            onClick={() => run("领取", (w) => w({ address: v.address, abi: vaultAbi, functionName: "claimWithdraw" }))}>
            领取排队中的资金
          </button>
        </div>
      )}
      <div className="small faint">取出排队 1 天，排队期间份额继续承担盈亏，防止看到大额支出前抢跑。份额不可转让。</div>
      <button className="btn btn-ghost" onClick={onClose}>关闭</button>
    </div>
  );
}

export function Vault() {
  const { deployment } = useDeployment();
  const { machines } = useMachines();
  const odds = useOddsListings();
  const [managing, setManaging] = useState<VaultRow | null>(null);
  const rows: VaultRow[] = [
    ...machines.map((m) => ({
      address: m.address, name: m.name, kind: "抽卡机器储备", tvl: m.totalAssets,
      note: `收入：庄家优势；风险：传说档集中出现。风险系数 ${m.riskBps / 100}%`,
    })),
    ...(deployment
      ? [{ address: deployment.odds, name: "概率买金库", kind: "概率买单的对手方", tvl: odds.totalAssets ?? 0n, note: "收入：每笔 3.5% 费用，扣除中奖时 1.5% 卖家奖励" }]
      : []),
  ];
  const tvl = rows.reduce((a, r) => a + r.tvl, 0n);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="between wrap">
        <div>
          <h1 className="h2">金库</h1>
          <div className="muted">为机器和概率买提供储备，赚玩家支付的娱乐成本。LP 的收益是剩余部分，会被返还率竞争压缩，也可能亏损。</div>
        </div>
        <div className="card" style={{ padding: "12px 20px" }}><Stat label="总储备" value={`$${fmtUsdc(tvl, 0)}`} /></div>
      </div>
      <div className="card card-pad">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>金库</th><th>储备</th><th>说明</th><th>我的仓位</th><th>排队取出</th><th /></tr></thead>
            <tbody>{rows.map((v) => <VaultLine key={v.address} v={v} onManage={setManaging} />)}</tbody>
          </table>
        </div>
      </div>
      <Modal open={!!managing} onClose={() => setManaging(null)} title={managing?.name}>
        {managing && <Manage v={managing} onClose={() => setManaging(null)} />}
      </Modal>
    </div>
  );
}
