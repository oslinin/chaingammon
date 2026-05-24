// Gas-sponsored contract writes (Privy native gas sponsorship).
//
// Privy can cover gas for transactions sent from a Privy *embedded* wallet
// (the wallet auto-created for email / Google logins). External wallets
// (MetaMask, WalletConnect) sign and pay their own gas as before — Privy
// cannot sponsor a wallet it does not control.
//
// This hook is a drop-in replacement for wagmi's `useWriteContract`: it
// exposes the same `writeContract` / `writeContractAsync` / `data` /
// `error` / `isPending` / `reset` surface so call sites swap the import and
// nothing else. Internally it branches on the active wallet:
//
//   - Embedded wallet  → encode the call to calldata and submit it through
//     Privy's `useSendTransaction({ sponsor: true })`. Privy's paymaster
//     pays the gas (configured per-chain in the Privy Dashboard).
//   - External wallet  → fall through to wagmi's `writeContractAsync`, the
//     existing behaviour, with the user paying gas.
//
// The returned `data` is a normal on-chain tx hash in both cases, so the
// usual `useWaitForTransactionReceipt({ hash: data })` keeps working
// regardless of who paid for gas.
//
// Dashboard requirement: native gas sponsorship must be enabled in the
// Privy Dashboard (Gas Sponsorship tab → enable + select the chains to
// sponsor), and the app must run on Privy's TEE execution. Without that the
// embedded-wallet path still submits the transaction but Privy rejects the
// `sponsor: true` flag.
"use client";

import { useState } from "react";
import { encodeFunctionData, type Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";

export interface SponsoredWriteParams {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Native value to attach (wei). */
  value?: bigint;
  /** Target chain; defaults to the embedded wallet's active chain when omitted. */
  chainId?: number;
}

export function useSponsoredWrite() {
  const { address } = useAccount();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const wagmi = useWriteContract();

  // State for the sponsored (embedded-wallet) path. wagmi owns the
  // equivalent state for the external-wallet path.
  const [sponsoredHash, setSponsoredHash] = useState<`0x${string}` | undefined>();
  const [sponsoredPending, setSponsoredPending] = useState(false);
  const [sponsoredError, setSponsoredError] = useState<Error | null>(null);

  // The active wallet is a Privy embedded wallet → eligible for gas
  // sponsorship. `privy-v2` covers Privy's newer embedded wallet client;
  // this mirrors the detection already used in team-demo settlement.
  const sponsored =
    !!address &&
    wallets.some(
      (w) =>
        w.address?.toLowerCase() === address.toLowerCase() &&
        (w.walletClientType === "privy" || w.walletClientType === "privy-v2"),
    );

  // Plain functions — the React Compiler memoizes them, so no manual
  // useCallback (which the compiler flags as unpreservable here).
  const writeContractAsync = async (
    params: SponsoredWriteParams,
  ): Promise<`0x${string}`> => {
    if (!sponsored) {
      return wagmi.writeContractAsync({
        address: params.address,
        abi: params.abi,
        functionName: params.functionName,
        args: params.args,
        value: params.value,
        chainId: params.chainId,
      } as Parameters<typeof wagmi.writeContractAsync>[0]);
    }

    setSponsoredPending(true);
    setSponsoredError(null);
    try {
      const data = encodeFunctionData({
        abi: params.abi,
        functionName: params.functionName,
        args: params.args ?? [],
      });
      const { hash } = await sendTransaction(
        {
          to: params.address,
          data,
          value: params.value,
          chainId: params.chainId,
        },
        // Privy covers gas for this transaction. `address` pins the send
        // to the active embedded wallet when a user has more than one.
        { sponsor: true, address },
      );
      setSponsoredHash(hash);
      return hash;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setSponsoredError(err);
      throw err;
    } finally {
      setSponsoredPending(false);
    }
  };

  // Fire-and-forget variant mirroring wagmi's `writeContract`. Errors land
  // in `error` (sponsored path) or `wagmi.error` (external path); the
  // rejected promise is swallowed here so it doesn't surface as unhandled.
  const writeContract = (params: SponsoredWriteParams) => {
    void writeContractAsync(params).catch(() => {});
  };

  const reset = () => {
    setSponsoredHash(undefined);
    setSponsoredError(null);
    setSponsoredPending(false);
    wagmi.reset();
  };

  return {
    writeContract,
    writeContractAsync,
    data: sponsored ? sponsoredHash : wagmi.data,
    error: sponsored ? sponsoredError : wagmi.error,
    isPending: sponsored ? sponsoredPending : wagmi.isPending,
    reset,
    /** True when writes are routed through Privy gas sponsorship. */
    sponsored,
  };
}
