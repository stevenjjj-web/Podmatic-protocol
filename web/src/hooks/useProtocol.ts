import { useMemo } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { erc20Abi, type Address, type Hex } from "viem";
import { bidBookAbi, factoryAbi, floorBookAbi, machineAbi, mockCollectionAbi, oddsAbi } from "../generated/abis";
import { useDeployment } from "./useDeployment";
import { COLLECTION_TRAIT, tokenTraitKeys } from "../lib/traits";
import type { CollectionData } from "../config/deployments";

const POLL = { refetchInterval: 4_000 } as const;

export type Tier = { minValue: bigint; maxValue: bigint; baseProbBps: number };
export type Odds = { open: boolean; goal: bigint; probs: readonly bigint[]; evs: readonly bigint[]; live: readonly boolean[] };

export type MachineInfo = {
  address: Address;
  name: string;
  nft: Address;
  creator: Address;
  spinPrice: bigint;
  targetRtpBps: number;
  creatorFeeBps: number;
  riskBps: number;
  totalAssets: bigint;
  totalShares: bigint;
  pendingSpins: bigint;
  listingCount: bigint;
  tiers: Tier[];
  tierSizes: number[];
  odds: Odds;
};

export function useUsdcBalance(owner?: Address) {
  const { deployment } = useDeployment();
  return useReadContract({
    address: deployment?.quote,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!deployment && !!owner, ...POLL },
  });
}

export function useMachineAddresses() {
  const { deployment } = useDeployment();
  const q = useReadContract({
    address: deployment?.factory,
    abi: factoryAbi,
    functionName: "allMachines",
    query: { enabled: !!deployment, ...POLL },
  });
  return { ...q, data: (q.data ?? []) as readonly Address[] };
}

const MACHINE_FIELDS = [
  "name", "nft", "creator", "spinPrice", "targetRtpBps", "creatorFeeBps", "riskBps",
  "totalAssets", "totalShares", "pendingSpins", "listingCount", "tierCount", "previewOdds",
] as const;

export function useMachines(filter?: Address) {
  const { data: all, isLoading: loadingList } = useMachineAddresses();
  const addresses = filter ? all.filter((a) => a.toLowerCase() === filter.toLowerCase()) : all;

  const base = useReadContracts({
    contracts: addresses.flatMap((address) => MACHINE_FIELDS.map((functionName) => ({ address, abi: machineAbi, functionName }))),
    query: { enabled: addresses.length > 0, ...POLL },
  });

  const tierCounts = addresses.map((_, i) => Number(base.data?.[i * MACHINE_FIELDS.length + 11]?.result ?? 0));
  const tierCalls = addresses.flatMap((address, i) =>
    Array.from({ length: tierCounts[i] }, (_, k) => [
      { address, abi: machineAbi, functionName: "tiers" as const, args: [BigInt(k)] as const },
      { address, abi: machineAbi, functionName: "tierListings" as const, args: [BigInt(k)] as const },
    ]).flat(),
  );
  const tiers = useReadContracts({ contracts: tierCalls, query: { enabled: tierCalls.length > 0, ...POLL } });

  const machines = useMemo<MachineInfo[]>(() => {
    if (!base.data) return [];
    let cursor = 0;
    return addresses.map((address, i) => {
      const r = (k: number) => base.data![i * MACHINE_FIELDS.length + k]?.result as never;
      const n = tierCounts[i];
      const t: Tier[] = [];
      const sizes: number[] = [];
      for (let k = 0; k < n; k++) {
        const tier = tiers.data?.[cursor++]?.result as { minValue: bigint; maxValue: bigint; baseProbBps: number } | undefined;
        const ids = tiers.data?.[cursor++]?.result as readonly bigint[] | undefined;
        t.push(tier ?? { minValue: 0n, maxValue: 0n, baseProbBps: 0 });
        sizes.push(ids?.length ?? 0);
      }
      const odds = (r(12) as Odds | undefined) ?? { open: false, goal: 0n, probs: [], evs: [], live: [] };
      return {
        address,
        name: r(0) ?? "",
        nft: r(1),
        creator: r(2),
        spinPrice: r(3) ?? 0n,
        targetRtpBps: Number(r(4) ?? 0),
        creatorFeeBps: Number(r(5) ?? 0),
        riskBps: Number(r(6) ?? 0),
        totalAssets: r(7) ?? 0n,
        totalShares: r(8) ?? 0n,
        pendingSpins: r(9) ?? 0n,
        listingCount: r(10) ?? 0n,
        tiers: t,
        tierSizes: sizes,
        odds,
      };
    });
  }, [base.data, tiers.data, addresses.join(), tierCounts.join()]);

  return { machines, isLoading: loadingList || base.isLoading };
}

export type Bid = {
  id: number;
  bidder: Address;
  nft: Address;
  traitKey: Hex;
  price: bigint;
  remaining: number;
  updatedAt: bigint;
  active: boolean;
  eligible: boolean;
};

export function useBids() {
  const { deployment } = useDeployment();
  const count = useReadContract({
    address: deployment?.bidBook,
    abi: bidBookAbi,
    functionName: "bidCount",
    query: { enabled: !!deployment, ...POLL },
  });
  const n = Number(count.data ?? 0n);
  const raw = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: deployment?.bidBook,
      abi: bidBookAbi,
      functionName: "bids" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: n > 0, ...POLL },
  });
  const rows = (raw.data ?? []).map((d) => d.result as Omit<Bid, "id" | "eligible"> | undefined);
  const elig = useReadContracts({
    contracts: rows.map((b, i) => ({
      address: deployment?.bidBook,
      abi: bidBookAbi,
      functionName: "isValuationEligible" as const,
      args: [BigInt(i), b?.nft ?? "0x0000000000000000000000000000000000000000", b?.traitKey ?? COLLECTION_TRAIT] as const,
    })),
    query: { enabled: rows.length > 0, ...POLL },
  });
  const bids = useMemo<Bid[]>(
    () =>
      rows
        .map((b, i) => (b ? { ...b, id: i, remaining: Number(b.remaining), eligible: !!elig.data?.[i]?.result } : undefined))
        .filter((b): b is Bid => !!b),
    [raw.data, elig.data],
  );
  return { bids, isLoading: count.isLoading || raw.isLoading };
}

/** Highest active bid that can buy this token right now (any age), and the highest that can value it in a machine. */
export function bestBidsFor(bids: Bid[], collection: CollectionData | undefined, nft: Address | undefined, tokenId: number) {
  if (!nft) return { fill: undefined, valuation: undefined };
  const keys = new Set<string>([COLLECTION_TRAIT, ...tokenTraitKeys(collection, tokenId)]);
  const applicable = bids.filter(
    (b) => b.active && b.remaining > 0 && b.nft.toLowerCase() === nft.toLowerCase() && keys.has(b.traitKey),
  );
  const byPrice = (a: Bid, b: Bid) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0);
  return {
    fill: applicable.sort(byPrice)[0],
    valuation: applicable.filter((b) => b.eligible).sort(byPrice)[0],
  };
}

export type FloorOrder = {
  id: number;
  maker: Address;
  nft: Address;
  spotPrice: bigint;
  deltaBps: number;
  feeBps: number;
  cash: bigint;
  active: boolean;
  bid: bigint;
  ask: bigint;
  inventory: readonly bigint[];
};

export function useFloorOrders() {
  const { deployment } = useDeployment();
  const count = useReadContract({
    address: deployment?.floorBook,
    abi: floorBookAbi,
    functionName: "orderCount",
    query: { enabled: !!deployment, ...POLL },
  });
  const n = Number(count.data ?? 0n);
  const calls = Array.from({ length: n }, (_, i) =>
    (["orders", "bidPrice", "askPrice", "inventory"] as const).map((functionName) => ({
      address: deployment?.floorBook,
      abi: floorBookAbi,
      functionName,
      args: [BigInt(i)] as const,
    })),
  ).flat();
  const raw = useReadContracts({ contracts: calls, query: { enabled: n > 0, ...POLL } });
  const orders = useMemo<FloorOrder[]>(() => {
    if (!raw.data) return [];
    return Array.from({ length: n }, (_, i) => {
      const o = raw.data![i * 4]?.result as Omit<FloorOrder, "id" | "bid" | "ask" | "inventory">;
      return {
        ...o,
        id: i,
        deltaBps: Number(o?.deltaBps ?? 0),
        feeBps: Number(o?.feeBps ?? 0),
        bid: (raw.data![i * 4 + 1]?.result as bigint) ?? 0n,
        ask: (raw.data![i * 4 + 2]?.result as bigint) ?? 0n,
        inventory: (raw.data![i * 4 + 3]?.result as readonly bigint[]) ?? [],
      };
    }).filter((o) => o.maker);
  }, [raw.data, n]);
  return { orders, isLoading: count.isLoading || raw.isLoading };
}

export type OddsListing = { id: number; seller: Address; nft: Address; tokenId: bigint; ask: bigint; active: boolean; pending: boolean };

export function useOddsListings() {
  const { deployment } = useDeployment();
  const reads = useReadContracts({
    contracts: [
      { address: deployment?.odds, abi: oddsAbi, functionName: "listingCount" },
      { address: deployment?.odds, abi: oddsAbi, functionName: "maxAsk" },
      { address: deployment?.odds, abi: oddsAbi, functionName: "totalAssets" },
      { address: deployment?.odds, abi: oddsAbi, functionName: "totalShares" },
    ],
    query: { enabled: !!deployment, ...POLL },
  });
  const n = Number((reads.data?.[0]?.result as bigint | undefined) ?? 0n);
  const raw = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: deployment?.odds,
      abi: oddsAbi,
      functionName: "listings" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: n > 0, ...POLL },
  });
  const listings = useMemo<OddsListing[]>(
    () => (raw.data ?? []).map((d, i) => ({ ...(d.result as Omit<OddsListing, "id">), id: i })).filter((l) => l.seller),
    [raw.data],
  );
  return {
    listings,
    maxAsk: reads.data?.[1]?.result as bigint | undefined,
    totalAssets: reads.data?.[2]?.result as bigint | undefined,
    totalShares: reads.data?.[3]?.result as bigint | undefined,
  };
}

/** Tokens of the demo collection held by the connected wallet (uses ERC721Enumerable). */
export function useMyNfts() {
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const nft = deployment?.demoCollection;
  const bal = useReadContract({
    address: nft,
    abi: mockCollectionAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!nft && !!address, ...POLL },
  });
  const n = Math.min(Number(bal.data ?? 0n), 200);
  const ids = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: nft,
      abi: mockCollectionAbi,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [address!, BigInt(i)] as const,
    })),
    query: { enabled: n > 0, ...POLL },
  });
  const tokens = useMemo(
    () => (ids.data ?? []).map((d) => d.result as bigint | undefined).filter((x): x is bigint => x !== undefined).sort((a, b) => Number(a - b)),
    [ids.data],
  );
  return { nft, tokens, isLoading: bal.isLoading || ids.isLoading };
}
