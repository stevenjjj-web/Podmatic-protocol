import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: { url: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111, accounts },
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org", chainId: 84532, accounts },
    mainnet: { url: process.env.MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com", chainId: 1, accounts },
    base: { url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org", chainId: 8453, accounts },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
};

export default config;
