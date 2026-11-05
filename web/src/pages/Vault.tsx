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
      <td><button className="btn btn-sm btn-soft" onClick={() => onManage(v)}>Manage</button></td>
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
        <Stat label="My position" value={`$${fmtUsdc(p.assets)}`} />
        <Stat label="Queued" value={`$${fmtUsdc(p.queuedAssets)}`} hint={p.queuedShares ? (unlocked ? "Claimable" : `${fmtDuration(Number(p.unlockAt - (now ?? 0n)))}`) : undefined} />
      </div>
      <div className="tabs">
        <button className={`tab ${tab === "deposit" ? "active" : ""}`} onClick={() => setTab("deposit")}>Deposit</button>
        <button className={`tab ${tab === "withdraw" ? "active" : ""}`} onClick={() => setTab("withdraw")}>Withdraw</button>
      </div>
      <AmountPanel label={tab === "deposit" ? "Deposit USDC" : "Withdraw USDC (converted to shares at current NAV)"} value={amount} onChange={setAmount} />
      {tab === "deposit" ? (
        <button className="btn btn-primary btn-lg" disabled={!address || busy || value === 0n}
          onClick={async () => {
            if (!deployment || !(await ensureToken(deployment.quote, v.address, value))) return;
            await run(`Deposit $${fmtUsdc(value)} into ${v.name}`, (w) => w({ address: v.address, abi: vaultAbi, functionName: "deposit", args: [value] }));
            setAmount("");
          }}>
          Deposit
        </button>
      ) : (
        <div className="stack">
          <button className="btn btn-primary btn-lg" disabled={!address || busy || sharesToQueue === 0n}
            onClick={() => run("Request withdrawal (1-day queue)", (w) => w({ address: v.address, abi: vaultAbi, functionName: "requestWithdraw", args: [sharesToQueue] }))}>
            Request withdrawal
          </button>
          <button className="btn btn-lg" disabled={!address || busy || !unlocked}
            onClick={() => run("Claim", (w) => w({ address: v.address, abi: vaultAbi, functionName: "claimWithdraw" }))}>
            Claim queued funds
          </button>
        </div>
      )}
      <div className="small faint">Withdrawals queue for 1 day and queued shares keep bearing profit and loss, so nobody can exit ahead of a large payout. Shares are non-transferable.</div>
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
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
      address: m.address, name: m.name, kind: "Machine reserve", tvl: m.totalAssets,
      note: `Income: house edge. Risk: legendary hits clustering. Risk factor ${m.riskBps / 100}%`,
    })),
    ...(deployment
      ? [{ address: deployment.odds, name: "Odds vault", kind: "Counterparty to odds buys", tvl: odds.totalAssets ?? 0n, note: "Income: 3.5% fee per buy, minus a 1.5% seller bonus on wins" }]
      : []),
  ];
  const tvl = rows.reduce((a, r) => a + r.tvl, 0n);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="between wrap">
        <div>
          <h1 className="h2">Vault</h1>
          <div className="muted">Fund the reserves behind machines and odds and earn what players pay for entertainment. LP income is the residual: competition on returns squeezes it, and it can be negative.</div>
        </div>
        <div className="card" style={{ padding: "12px 20px" }}><Stat label="Total reserve" value={`$${fmtUsdc(tvl, 0)}`} /></div>
      </div>
      <div className="card card-pad">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Vault</th><th>Reserve</th><th>Notes</th><th>My position</th><th>Queued withdrawal</th><th /></tr></thead>
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
