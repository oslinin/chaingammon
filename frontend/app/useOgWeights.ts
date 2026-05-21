"use client";

import { useEffect, useState } from "react";
import { fetchOgWeights, type OgWeightsResult } from "./og-weights-reader";

const ZERO_HASH = "0x" + "0".repeat(64);

export function useOgWeights(rootHash: string | undefined) {
  const [result, setResult] = useState<OgWeightsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rootHash || rootHash === ZERO_HASH) {
      setResult({ kind: "null", reason: "no hash on chain yet" });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOgWeights(rootHash)
      .then((r) => { if (!cancelled) { setResult(r); setLoading(false); } })
      .catch((e: unknown) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [rootHash]);

  return { result, loading, error };
}
