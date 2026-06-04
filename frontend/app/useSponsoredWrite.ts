// Thin wrapper around wagmi's useWriteContract.
// Previously routed embedded-wallet transactions through Privy gas sponsorship;
// now that Privy is removed all writes go through MetaMask directly.
"use client";

import { useWriteContract } from "wagmi";
import type { Abi } from "viem";

export interface SponsoredWriteParams {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  chainId?: number;
}

export function useSponsoredWrite() {
  const wagmi = useWriteContract();

  const writeContractAsync = (params: SponsoredWriteParams) =>
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
    sponsored: false,
  };
}
