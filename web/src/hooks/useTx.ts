import { useCallback, useState } from "react";
import { usePublicClient, useWriteContract, useChainId } from "wagmi";
import { BaseError, type Hash, type TransactionReceipt } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useToasts } from "../components/Toasts";
import { chainMeta } from "../config/chains";

export function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const reason = e.walk((err) => "reason" in (err as object) && !!(err as { reason?: string }).reason) as
      | { reason?: string }
      | null;
    if (reason?.reason) return reason.reason;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Sends a transaction, waits for the receipt, shows toasts and refreshes on-chain reads. */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const chainId = useChainId();
  const toasts = useToasts();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (title: string, send: (write: typeof writeContractAsync) => Promise<Hash>): Promise<TransactionReceipt | undefined> => {
      const id = toasts.push({ title, body: "请在钱包中确认", kind: "pending" });
      setBusy(true);
      try {
        const hash = await send(writeContractAsync);
        const explorer = chainMeta[chainId]?.explorer;
        toasts.update(id, { body: "等待上链…", href: explorer ? `${explorer}/tx/${hash}` : undefined });
        const receipt = await client!.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("交易失败");
        toasts.update(id, { kind: "success", body: "已确认" });
        await queryClient.invalidateQueries();
        return receipt;
      } catch (e) {
        toasts.update(id, { kind: "error", body: errorMessage(e) });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [writeContractAsync, client, chainId, toasts, queryClient],
  );

  return { run, busy };
}
