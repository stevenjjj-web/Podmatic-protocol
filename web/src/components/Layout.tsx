import { NavLink, Outlet } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";
import { useAccount, useBlockNumber } from "wagmi";
import { chainMeta } from "../config/chains";
import { useDeployment } from "../hooks/useDeployment";
import { useUsdcBalance } from "../hooks/useProtocol";
import { useTx } from "../hooks/useTx";
import { mockUsdcAbi } from "../generated/abis";
import { fmtUsdc } from "../lib/format";

const NAV = [
  { to: "/", label: "Spin", end: true },
  { to: "/sell", label: "Sell" },
  { to: "/bids", label: "Bids" },
  { to: "/pool", label: "Pool" },
  { to: "/odds", label: "Odds" },
  { to: "/vault", label: "Vault" },
  { to: "/create", label: "Create" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("theme") || "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  return (
    <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme" title="Toggle theme">
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

function WalletButtons() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        if (!mounted) return null;
        if (!account || !chain) {
          return (
            <button className="btn btn-soft" onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        }
        const meta = chainMeta[chain.id];
        return (
          <div className="row">
            <button className="pill" onClick={openChainModal}>
              <span className="chain-dot" style={{ background: chain.unsupported ? "var(--critical)" : meta?.color }} />
              <span className="hide-sm">{chain.unsupported ? "Unsupported network" : meta?.short ?? chain.name}</span>
              <span className="faint">▾</span>
            </button>
            <button className="pill" onClick={openAccountModal}>
              <span className="chain-dot" style={{ background: "linear-gradient(135deg,#FF37C7,#8A5CFF)" }} />
              {account.displayName}
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function NetworkNotice() {
  const { deployment, chainId, isLocal } = useDeployment();
  const { isError } = useBlockNumber({ watch: isLocal, query: { enabled: isLocal } });
  if (isLocal && isError) {
    return (
      <div className="notice notice-bad" style={{ marginBottom: 16 }}>
        Cannot reach the local node at http://127.0.0.1:8545. Run <code>npm run dev</code> in the project root (it starts the node, deploys and seeds demo data).
      </div>
    );
  }
  if (!deployment) {
    return (
      <div className="notice notice-warn" style={{ marginBottom: 16 }}>
        Podmatic is not deployed on {chainMeta[chainId]?.short ?? `chain ${chainId}`} yet. Switch to the Local network to try it;
        see "Deploying to Ethereum / Base" in the README.
      </div>
    );
  }
  return null;
}

function Faucet() {
  const { address } = useAccount();
  const { deployment, isLocal } = useDeployment();
  const { data: bal } = useUsdcBalance(address);
  const { run, busy } = useTx();
  if (!address || !deployment) return null;
  return (
    <div className="row small hide-sm">
      <span className="muted mono">{fmtUsdc(bal)} USDC</span>
      {isLocal && (
        <button
          className="btn btn-sm btn-soft"
          disabled={busy}
          onClick={() =>
            run("Claim 10,000 test USDC", (w) =>
              w({ address: deployment.quote, abi: mockUsdcAbi, functionName: "mint", args: [address, 10_000_000_000n] }),
            )
          }
        >
          Get test USDC
        </button>
      )}
    </div>
  );
}

export function Layout() {
  return (
    <div className="app">
      <header className="header">
        <NavLink to="/" className="logo">
          <img src="/favicon.svg" alt="" />
          <span className="logo-text">Pod<span>matic</span></span>
        </NavLink>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="header-right">
          <Faucet />
          <ThemeToggle />
          <WalletButtons />
        </div>
      </header>
      <main className="main">
        <NetworkNotice />
        <Outlet />
      </main>
      <footer className="footer">
        Podmatic · Market making for collectibles · Contracts are unaudited: use on testnets and locally only ·{" "}
        <a href="https://github.com/stevenjjj-web/Podmatic-protocol" target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </div>
  );
}
