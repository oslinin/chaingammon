import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // COOP/COEP headers allow SharedArrayBuffer in the browser, which the
  // threaded ONNX WASM binary can use when numThreads > 1. With numThreads=1
  // these headers are not strictly needed, but they're harmless in dev and
  // prevent a cryptic fallback-chain if a future build re-enables threading.
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
      ],
    },
  ],
};

export default nextConfig;
