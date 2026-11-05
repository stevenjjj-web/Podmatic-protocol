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
  { to: "/", label: "抽卡", end: true },
  { to: "/sell", label: "挂卡" },
  { to: "/bids", label: "买单" },
  { to: "/pool", label: "做市" },
  { to: "/odds", label: "概率买" },
  { to: "/vault", label: "金库" },
  { to: "/create", label: "开机器" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("theme") || "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  return (
    <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="切换主题" title="切换主题">
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
              连接钱包
            </button>
          );
        }
        const meta = chainMeta[chain.id];
        return (
          <div className="row">
            <button className="pill" onClick={openChainModal}>
              <span className="chain-dot" style={{ background: chain.unsupported ? "var(--critical)" : meta?.color }} />
              <span className="hide-sm">{chain.unsupported ? "不支持的网络" : meta?.short ?? chain.name}</span>
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
        连不上本地节点 http://127.0.0.1:8545。请在项目根目录运行 <code>npm run dev</code>（会启动节点、部署并填充演示数据）。
      </div>
    );
  }
  if (!deployment) {
    return (
      <div className="notice notice-warn" style={{ marginBottom: 16 }}>
        Podmatic 还没有部署到 {chainMeta[chainId]?.short ?? `链 ${chainId}`}。本地体验请切换到 Local 网络；
        部署到 Ethereum / Base 见 README 的“部署”一节。
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
            run("领取 10,000 测试 USDC", (w) =>
              w({ address: deployment.quote, abi: mockUsdcAbi, functionName: "mint", args: [address, 10_000_000_000n] }),
            )
          }
        >
          领测试币
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
        Podmatic · 收藏品的做市协议 · 合约未经审计，请只在测试网和本地使用 ·{" "}
        <a href="https://github.com/stevenjjj-web/Podmatic-protocol" target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </div>
  );
}
