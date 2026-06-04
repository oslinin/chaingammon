// Gas-sponsored contract writes — simplified after Privy removal.
//
// Previously this hook branched on whether the active wallet was a Privy
// embedded wallet (email / Google login) to route through Privy's native
// gas sponsorship. Now that Privy is removed, all wallets are external
// (MetaMask, injected) and pay their own gas via wagmi's standard
// useWriteContract — so this hook is a thin pass-through that preserves
// the same call-site API surface (writeContractAsync, writeContract, data,
// error, isPending, reset, sponsored) for zero churn in callers.
//
// The `sponsored` flag is always false — no embedded-wallet paymaster
// is active. It is kept in the return value so callers that read it
// (e.g. to show a "gas is covered" badge) continue to compile without
// changes.
"use client";

import type { Abi } from "viem";
import { useWriteContract } from "wagmi";

export interface SponsoredWriteParams {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Native value to attach (wei). */
  value?: bigint;
  /** Target chain; forwarded to wagmi's writeContractAsync. */
  chainId?: number;
}

export function useSponsoredWrite() {
  const wagmi = useWriteContract();

  const writeContractAsync = (params: SponsoredWriteParams): Promise<`0x${string}`> =>
    wagmi.writeContractAsync({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      value: params.value,
      chainId: params.chainId,
    } as Parameters<typeof wagmi.writeContractAsync>[0]);

  const writeContract = (params: SponsoredWriteParams) => {
    void writeContractAsync(params).catch(() => {});
  };

  return {
    writeContract,
    writeContractAsync,
    data: wagmi.data,
    error: wagmi.error,
    isPending: wagmi.isPending,
    reset: wagmi.reset,
    /** Always false — Privy gas sponsorship was removed. */
    sponsored: false,
  };
}
