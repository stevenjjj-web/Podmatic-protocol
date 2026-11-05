import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toUtf8Bytes, ZeroHash } from "ethers";

/** Trait key as stored on chain: keccak256("Type:Value"). The zero key means "any token in the collection". */
export function traitKey(type: string, value: string): string {
  return keccak256(toUtf8Bytes(`${type}:${value}`));
}

export const COLLECTION_TRAIT = ZeroHash;

/** Trait table for the demo collection, with the share of tokens that get each value. */
export const TRAIT_TABLE: Record<string, [string, number][]> = {
  Hat: [["None", 0.55], ["Cap", 0.25], ["Beanie", 0.1], ["Crown", 0.07], ["Halo", 0.03]],
  Fur: [["Brown", 0.5], ["Grey", 0.3], ["White", 0.14], ["Gold", 0.06]],
  Eyes: [["Calm", 0.6], ["Sleepy", 0.25], ["Laser", 0.15]],
};

export type TokenTraits = { tokenId: number; traits: Record<string, string> };

export type DemoCollection = {
  tokens: TokenTraits[];
  root: string;
  /** tokenId -> traitKey -> proof */
  proofs: Record<number, Record<string, string[]>>;
  /** traitKey -> count */
  counts: Record<string, number>;
  /** traitKey -> "Type:Value" */
  labels: Record<string, string>;
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Deterministic traits for `size` tokens and the Merkle tree the registry commits to. */
export function buildDemoCollection(size: number, seed = 7): DemoCollection {
  const rand = rng(seed);
  const tokens: TokenTraits[] = [];
  for (let id = 0; id < size; id++) {
    const traits: Record<string, string> = {};
    for (const [type, values] of Object.entries(TRAIT_TABLE)) {
      let r = rand();
      let pick = values[values.length - 1][0];
      for (const [value, share] of values) {
        if (r < share) {
          pick = value;
          break;
        }
        r -= share;
      }
      traits[type] = pick;
    }
    tokens.push({ tokenId: id, traits });
  }

  const leaves: [bigint, string][] = [];
  const counts: Record<string, number> = {};
  const labels: Record<string, string> = {};
  for (const t of tokens) {
    for (const [type, value] of Object.entries(t.traits)) {
      const key = traitKey(type, value);
      leaves.push([BigInt(t.tokenId), key]);
      counts[key] = (counts[key] ?? 0) + 1;
      labels[key] = `${type}:${value}`;
    }
  }
  const tree = StandardMerkleTree.of(leaves, ["uint256", "bytes32"]);
  const proofs: Record<number, Record<string, string[]>> = {};
  for (const [i, [tokenId, key]] of tree.entries()) {
    const id = Number(tokenId);
    proofs[id] ??= {};
    proofs[id][key] = tree.getProof(i);
  }
  return { tokens, root: tree.root, proofs, counts, labels };
}
