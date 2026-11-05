import { defineChain, type Chain } from "viem";
import { mainnet, base, sepolia, baseSepolia } from "viem/chains";

const env = import.meta.env;

export const localChain = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.VITE_LOCAL_RPC_URL || "http://127.0.0.1:8545"] } },
  testnet: true,
});

export const localEnabled = env.DEV || env.VITE_ENABLE_LOCAL === "true";

/** Deployment targets: Ethereum and Base, their testnets, and a local Hardhat node in development. */
// The first chain is the default before a wallet connects: Local in development, Ethereum otherwise.
export const chains = [
  ...(localEnabled ? [localChain] : []),
  mainnet,
  base,
  sepolia,
  baseSepolia,
] as unknown as readonly [Chain, ...Chain[]];

export const rpcOverrides: Record<number, string | undefined> = {
  [mainnet.id]: env.VITE_MAINNET_RPC_URL,
  [base.id]: env.VITE_BASE_RPC_URL,
  [sepolia.id]: env.VITE_SEPOLIA_RPC_URL,
  [baseSepolia.id]: env.VITE_BASE_SEPOLIA_RPC_URL,
  [localChain.id]: env.VITE_LOCAL_RPC_URL || "http://127.0.0.1:8545",
};

export const chainMeta: Record<number, { short: string; color: string; explorer?: string }> = {
  [mainnet.id]: { short: "Ethereum", color: "#627EEA", explorer: "https://etherscan.io" },
  [base.id]: { short: "Base", color: "#0052FF", explorer: "https://basescan.org" },
  [sepolia.id]: { short: "Sepolia", color: "#9B8AFB", explorer: "https://sepolia.etherscan.io" },
  [baseSepolia.id]: { short: "Base Sepolia", color: "#5B8DEF", explorer: "https://sepolia.basescan.org" },
  [localChain.id]: { short: "Local", color: "#FF37C7" },
};
