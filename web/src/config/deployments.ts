import type { Address, Hex } from "viem";

export type Deployment = {
  chainId: number;
  network: string;
  quote: Address;
  registry: Address;
  bidBook: Address;
  floorBook: Address;
  factory: Address;
  odds: Address;
  randomness: Address;
  randomnessKind: "mock" | "chainlink";
  demoCollection?: Address;
  deployedAt: string;
};

export type CollectionData = {
  chainId: number;
  address: Address;
  name: string;
  tokens: { tokenId: number; traits: Record<string, string> }[];
  root: Hex;
  proofs: Record<string, Record<string, Hex[]>>;
  counts: Record<string, number>;
  labels: Record<string, string>;
};

// Files are written by contracts/scripts/deploy.ts. A missing file just means "not deployed on that chain".
const deploymentFiles = import.meta.glob<Deployment>("../generated/deployment.*.json", { eager: true, import: "default" });
const collectionFiles = import.meta.glob<CollectionData>("../generated/collection.*.json", { eager: true, import: "default" });

export const deployments: Record<number, Deployment> = Object.fromEntries(
  Object.values(deploymentFiles).map((d) => [d.chainId, d]),
);

export const collections: Record<number, CollectionData> = Object.fromEntries(
  Object.values(collectionFiles).map((c) => [c.chainId, c]),
);
