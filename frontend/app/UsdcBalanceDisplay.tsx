"use client";

// Shows the connected player's USDC balance in the navbar with a "Get USDC"
// dropdown offering three paths:
//   1. "Buy with card" — Privy's fiat on-ramp (MoonPay/Stripe); ideal for
//      web2 users who signed in with email or Google (embedded wallet).
//   2. "Deposit crypto (any chain)" — Privy's universal deposit address
//      (ETHGlobal NYC 2026, Stream 2). The user sends crypto from *any*
//      chain (e.g. Arbitrum ETH) to a generated address and Privy
//      automagically bridges + swaps it into Base USDC in their account.
//      Privy's own modal shows the bridge/swap status.
//   3. "Swap ETH" — deep link to Uniswap with the pair pre-filled.
//
// Falls back gracefully when usdcToken is the zero address (contracts not
// yet deployed on this chain).

import { useState, useRef, useEffect } from "react";
import { useReadContract } from "wagmi";
import { useFundWallet } from "@privy-io/react-auth";
// useDepositAddress lives on the /internal entry and is marked @experimental
// by Privy; it powers the universal "deposit crypto from any chain" flow.
import { useDepositAddress } from "@privy-io/react-auth/internal";

import { ERC20ABI, useChainContracts } from "./contracts";
import { useActiveChain } from "./chains";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC_DECIMALS = 6;

// Universal deposits always land as Base mainnet USDC, per Stream 2: the user
// can send from any chain and Privy bridges/swaps into this destination.
// CAIP-2 chain id for Base mainnet (eip155:8453); destination currency "usdc".
const BASE_USDC_CAIP2_CHAIN = "eip155:8453";
const DEPOSIT_DESTINATION_CURRENCY = "usdc";

function formatUsdc(raw: bigint): string {
  const n = Number(raw) / 10 ** USDC_DECIMALS;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Props {
  address: `0x${string}`;
}

export function UsdcBalanceDisplay({ address }: Props) {
  const { usdcToken } = useChainContracts();
  const activeChain = useActiveChain();
  const { fundWallet } = useFundWallet();
  const { createDepositAddress } = useDepositAddress();

  const [open, setOpen] = useState(false);
  const [buying, setBuying] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const noToken = !usdcToken || usdcToken === ZERO;

  const { data: rawBalance } = useReadContract({
    address: usdcToken,
    abi: ERC20ABI,
    functionName: "balanceOf",
    args: [address],
    query: { enabled: !noToken, refetchInterval: 15_000 },
  });

  const balance = (rawBalance as bigint | undefined) ?? BigInt(0);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (noToken) return null;

  const uniswapUrl = `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=ETH&outputCurrency=${usdcToken}`;

  const onBuyWithCard = async () => {
    setBuying(true);
    setOpen(false);
    try {
      await fundWallet({
        address,
        options: {
          chain: activeChain?.chain,
          asset: "USDC",
        },
      });
    } catch {
      // user dismissed or on-ramp unavailable — silently ignore
    } finally {
      setBuying(false);
    }
  };

  // Open Privy's universal deposit-address flow. The modal lets the user pick
  // any source chain/asset, generates a deposit address, and shows the
  // bridge/swap progress as it lands Base USDC in their wallet.
  const onDepositCrypto = async () => {
    setDepositing(true);
    setOpen(false);
    try {
      await createDepositAddress({
        destinationChain: BASE_USDC_CAIP2_CHAIN,
        destinationCurrency: DEPOSIT_DESTINATION_CURRENCY,
        destinationAddress: address,
      });
    } catch {
      // user dismissed or deposit flow unavailable — silently ignore
    } finally {
      setDepositing(false);
    }
  };

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      {/* Balance pill */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 32,
          borderRadius: "var(--cg-radius-pill)",
          padding: "0 10px 0 12px",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--cg-font-mono)",
          background: "var(--cg-surface-1)",
          border: "1px solid var(--cg-line-1)",
          color: "var(--cg-fg-1)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--cg-fg-2)", fontSize: 11 }}>USDC</span>
        <span>{formatUsdc(balance)}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          style={{
            color: "var(--cg-fg-3)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 120ms",
          }}
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 180,
            background: "var(--cg-surface-0)",
            border: "1px solid var(--cg-line-1)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            padding: "6px 0",
            zIndex: 100,
          }}
        >
          <p
            style={{
              margin: 0,
              padding: "4px 14px 6px",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--cg-fg-3)",
            }}
          >
            Get USDC
          </p>

          {/* Buy with card — fiat on-ramp via Privy (best for email/Google login) */}
          <button
            type="button"
            onClick={() => void onBuyWithCard()}
            disabled={buying}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "7px 14px",
              background: "none",
              border: "none",
              cursor: buying ? "wait" : "pointer",
              fontSize: 13,
              color: "var(--cg-fg-1)",
              textAlign: "left",
            }}
            className="hover:bg-[var(--cg-surface-1)]"
          >
            <span style={{ fontSize: 15 }}>💳</span>
            <span>{buying ? "Opening…" : "Buy with card"}</span>
          </button>

          {/* Deposit crypto from any chain — Privy universal deposit address,
              bridged + swapped into Base USDC */}
          <button
            type="button"
            onClick={() => void onDepositCrypto()}
            disabled={depositing}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "7px 14px",
              background: "none",
              border: "none",
              cursor: depositing ? "wait" : "pointer",
              fontSize: 13,
              color: "var(--cg-fg-1)",
              textAlign: "left",
            }}
            className="hover:bg-[var(--cg-surface-1)]"
          >
            <span style={{ fontSize: 15 }}>🌉</span>
            <span>{depositing ? "Opening…" : "Deposit crypto (any chain)"}</span>
          </button>

          {/* Swap ETH → USDC via Uniswap */}
          <a
            href={uniswapUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 14px",
              fontSize: 13,
              color: "var(--cg-fg-1)",
              textDecoration: "none",
            }}
            className="hover:bg-[var(--cg-surface-1)]"
          >
            <span style={{ fontSize: 15 }}>🔄</span>
            <span>Swap ETH ↗</span>
          </a>
        </div>
      )}
    </div>
  );
}
