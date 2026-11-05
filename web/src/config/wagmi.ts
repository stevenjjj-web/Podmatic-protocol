import { connectorsForWallets, type Wallet } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, createConnector, http } from "wagmi";
import { mock } from "wagmi/connectors";
import { chains, localEnabled, rpcOverrides } from "./chains";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";

/** Hardhat's first default account. Unlocked on a local node, so no private key is needed in the browser. */
export const LOCAL_DEV_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

const LOCAL_WALLET_KEY = "podmatic.localWallet";

const localDevWallet = (): Wallet => ({
  id: "podmatic-local-dev",
  name: "本地测试钱包",
  iconUrl: "/favicon.svg",
  iconBackground: "#FF37C7",
  createConnector: (details) =>
    createConnector((config) => {
      const base = mock({ accounts: [LOCAL_DEV_ACCOUNT], features: { reconnect: true } })(config);
      return {
        ...base,
        ...details,
        // The mock connector only remembers authorization in memory; persist it so a page reload reconnects.
        async connect(params) {
          const result = await base.connect(params);
          localStorage.setItem(LOCAL_WALLET_KEY, "1");
          return result;
        },
        async disconnect() {
          localStorage.removeItem(LOCAL_WALLET_KEY);
          await base.disconnect();
        },
        async isAuthorized() {
          return localStorage.getItem(LOCAL_WALLET_KEY) === "1";
        },
      };
    }),
});

const wallets = [
  ...(localEnabled ? [localDevWallet] : []),
  injectedWallet,
  rabbyWallet,
  coinbaseWallet,
  ...(projectId ? [metaMaskWallet, walletConnectWallet] : []),
];

const connectors = connectorsForWallets([{ groupName: "钱包", wallets }], {
  appName: "Podmatic",
  projectId: projectId || "podmatic-no-walletconnect",
});

export const wagmiConfig = createConfig({
  chains,
  connectors,
  transports: Object.fromEntries(chains.map((c) => [c.id, http(rpcOverrides[c.id])])),
  pollingInterval: 2_000,
});

export const defaultChainId = chains[0].id;
