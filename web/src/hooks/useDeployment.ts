import { useChainId } from "wagmi";
import { collections, deployments } from "../config/deployments";

export function useDeployment() {
  const chainId = useChainId();
  const deployment = deployments[chainId];
  const collection = collections[chainId];
  return { chainId, deployment, collection, isLocal: chainId === 31337 };
}
