import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Next 16 blocks cross-origin requests to /_next/* dev resources by
  // default. Without this, hitting the dev server from a non-localhost
  // host (phone / another laptop on the LAN) causes the JS bundles and
  // HMR to be refused, React never hydrates, and the navbar / agents
  // list show their pre-hydration shell forever. Add LAN hostnames as
  // needed. Docs:
  //   node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/allowedDevOrigins.md
  allowedDevOrigins: ["192.168.2.9"],
};

export default nextConfig;
