import type { NextConfig } from "next";

// BASE_PATH is set at build time for GitHub Pages (e.g. "/chaingammon").
// Leave unset (empty string) for local dev or a custom domain deployment.
// Example for GitHub Pages: BASE_PATH=/chaingammon pnpm frontend:build
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // `accounts` is an optional peer dep of @wagmi/core and @wagmi/connectors that
  // is not published to npm. @wagmi/core/tempo references it but the feature is
  // unused. Without this alias Webpack chokes trying to resolve the import.
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      accounts: false,
      '@metamask/connect-evm': false,
      'porto': false,
      'porto/internal': false,
      // Privy lazily references Farcaster's Solana mini-app SDK for a login
      // path we don't enable (Ethereum-only: email/Google/MetaMask/WC). It's
      // an optional peer dep that isn't installed, so alias it to an empty
      // module to silence the "Can't resolve" Webpack warning.
      '@farcaster/mini-app-solana': false,
    };
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        'fs/promises': false,
        child_process: false,
        path: false,
      };
    }
    return config;
  },

  // Static export — produces the `out/` directory which can be hosted on
  // GitHub Pages or any static file server. No Node.js server required.
  output: "export",

  // Trailing slashes so GitHub Pages serves /match/ as match/index.html
  // rather than returning 404 on direct navigation.
  trailingSlash: true,

  // Required for static export: Next.js image optimisation needs a server.
  // Disable it so <Image> passes through as a plain <img> in the static build.
  images: { unoptimized: true },

  // Prepend the repo subdirectory when deployed to GitHub Pages.
  // Set BASE_PATH=/chaingammon in the GitHub Actions workflow environment.
  basePath,

  // Expose basePath to client code so raw `<img src>`, fetch() calls, and
  // anything else not routed through next/link or next/image can prepend it.
  // next/link and next/image handle basePath automatically; this is the
  // escape hatch for assets fetched outside those abstractions (e.g. the
  // ONNX model loaded by a Web Worker, brand icons in <img> tags).
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },

  // COOP/COEP headers allow SharedArrayBuffer in the browser, which the
  // threaded ONNX WASM binary can use when numThreads > 1.  With numThreads=1
  // these headers are not strictly needed, but they're harmless in dev and
  // prevent a cryptic fallback-chain if a future build re-enables threading.
  // `headers` is ignored for `output: "export"` — static hosts must add them
  // via their own config (e.g. GitHub Pages does not support SAB without a
  // service-worker shim, which is why we keep numThreads=1).
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
      ],
    },
  ],

  // Next 16 blocks cross-origin requests to /_next/* dev resources by
  // default. Without this, hitting the dev server from a non-localhost
  // host (phone / another laptop on the LAN) causes the JS bundles and
  // HMR to be refused, React never hydrates, and the navbar / agents
  // list show their pre-hydration shell forever.
  // To test on a phone: add your machine's LAN IP here (e.g. "192.168.1.5").
  allowedDevOrigins: ["192.168.2.9", "172.19.0.1", "132.145.158.84"],
};

export default nextConfig;
