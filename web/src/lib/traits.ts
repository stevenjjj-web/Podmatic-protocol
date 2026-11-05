import { keccak256, toBytes, zeroHash, type Hex } from "viem";
import type { CollectionData } from "../config/deployments";

export const COLLECTION_TRAIT = zeroHash;

export const traitKey = (type: string, value: string): Hex => keccak256(toBytes(`${type}:${value}`));

export function traitLabel(c: CollectionData | undefined, key: Hex): string {
  if (key === COLLECTION_TRAIT) return "Any token (floor)";
  const l = c?.labels[key];
  if (!l) return `${key.slice(0, 10)}…`;
  const [type, value] = l.split(":");
  return `${TRAIT_NAMES[type] ?? type} · ${value}`;
}

export const TRAIT_NAMES: Record<string, string> = { Hat: "Hat", Fur: "Fur", Eyes: "Eyes" };

export function tokenTraits(c: CollectionData | undefined, tokenId: number | bigint) {
  return c?.tokens[Number(tokenId)]?.traits;
}

export function tokenTraitKeys(c: CollectionData | undefined, tokenId: number | bigint): Hex[] {
  const p = c?.proofs[String(Number(tokenId))];
  return p ? (Object.keys(p) as Hex[]) : [];
}

export function proofFor(c: CollectionData | undefined, tokenId: number | bigint, key: Hex): Hex[] {
  if (key === COLLECTION_TRAIT) return [];
  return c?.proofs[String(Number(tokenId))]?.[key] ?? [];
}
