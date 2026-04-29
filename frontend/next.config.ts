import type { NextConfig } from "next";

// BASE_PATH is set at build time for GitHub Pages (e.g. "/chaingammon").
// Leave unset (empty string) for local dev or a custom domain deployment.
// Example for GitHub Pages: BASE_PATH=/chaingammon pnpm frontend:build
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
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

  // Next 16 blocks cross-origin requests to /_next/* dev resources by
  // default. Without this, hitting the dev server from a non-localhost
  // host (phone / another laptop on the LAN) causes the JS bundles and
  // HMR to be refused, React never hydrates, and the navbar / agents
  // list show their pre-hydration shell forever.
  allowedDevOrigins: ["192.168.2.9"],
};

export default nextConfig;
