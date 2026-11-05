import { useQuery } from "@tanstack/react-query";
import { useBlock, usePublicClient } from "wagmi";
import type { Abi, Address, ContractEventName } from "viem";
import { useDeployment } from "./useDeployment";

/** Latest block timestamp. The local chain is fast-forwarded during seeding, so wall-clock time would be wrong. */
export function useChainTime(): bigint | undefined {
  const { data } = useBlock({ watch: true });
  return data?.timestamp;
}

/** Recent events of one contract. On public chains only the last ~50k blocks are scanned. */
export function useContractEvents<const abi extends Abi>(params: {
  address?: Address;
  abi: abi;
  eventName: ContractEventName<abi>;
  args?: Record<string, unknown>;
  enabled?: boolean;
}) {
  const client = usePublicClient();
  const { isLocal } = useDeployment();
  return useQuery({
    queryKey: ["events", params.address, params.eventName, JSON.stringify(params.args ?? {}, (_, v) => (typeof v === "bigint" ? v.toString() : v))],
    enabled: !!client && !!params.address && params.enabled !== false,
    refetchInterval: 5_000,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const fromBlock = isLocal || latest < 50_000n ? 0n : latest - 50_000n;
      const logs = await client!.getContractEvents({
        address: params.address!,
        abi: params.abi as Abi,
        eventName: params.eventName as string,
        args: params.args as never,
        fromBlock,
        toBlock: latest,
      });
      return logs.reverse();
    },
  });
}
