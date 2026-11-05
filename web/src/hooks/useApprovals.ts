import { useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { erc20Abi, erc721Abi, maxUint256, type Address } from "viem";
import { useTx } from "./useTx";

/** Approves USDC or an NFT collection only when the current allowance is not enough. */
export function useApprovals() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { run } = useTx();

  const ensureToken = useCallback(
    async (token: Address, spender: Address, amount: bigint) => {
      if (!address || !client) return false;
      const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, spender] });
      if (allowance >= amount) return true;
      const r = await run("Approve USDC", (w) => w({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }));
      return !!r;
    },
    [address, client, run],
  );

  const ensureNft = useCallback(
    async (nft: Address, operator: Address) => {
      if (!address || !client) return false;
      const ok = await client.readContract({ address: nft, abi: erc721Abi, functionName: "isApprovedForAll", args: [address, operator] });
      if (ok) return true;
      const r = await run("Approve NFT", (w) => w({ address: nft, abi: erc721Abi, functionName: "setApprovalForAll", args: [operator, true] }));
      return !!r;
    },
    [address, client, run],
  );

  return { ensureToken, ensureNft };
}
