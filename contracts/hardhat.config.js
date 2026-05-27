require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      // Enable Yul-IR codegen so the new settleWithSessionKeys function
      // in MatchRegistry compiles. Without it the function trips
      // "Stack too deep" — it keeps too many locals live across the
      // inline keccak256(abi.encodePacked(...)) blocks for solc's
      // legacy stack scheduler. viaIR's IR-based codegen handles
      // deeper stacks at the cost of slightly slower compile times.
      viaIR: true,
    },
  },
  paths: {
    sources: "./src",
  },
  networks: {
    localhost: {
      chainId: 31337,
    },
    "0g-testnet": {
      url: process.env.RPC_URL || "https://evmrpc-testnet.0g.ai",
      chainId: 16602,
      accounts,
    },
    sepolia: {
      // Default RPC is publicnode's Sepolia endpoint. The old default
      // (rpc.sepolia.org) returned Cloudflare 522 / connection timeout
      // by late 2025 — replaced by publicnode, which is also what the
      // frontend's NEXT_PUBLIC_SEPOLIA_RPC_URL fallback points at.
      // Override with SEPOLIA_RPC_URL if you have a private RPC.
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
      chainId: 11155111,
      accounts,
    },
    // ── Multichain testnets ──────────────────────────────────────────────────
    // Base Sepolia — L2 by Coinbase (OP Stack), mirrors Ethereum Sepolia state.
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    // Avalanche Fuji — Avalanche C-Chain testnet; same EVM API as mainnet.
    "avalanche-fuji": {
      url: process.env.AVALANCHE_FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts,
    },
    // Polygon Amoy — replaces Mumbai as the canonical Polygon PoS testnet.
    "polygon-amoy": {
      url: process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts,
    },
    // Optimism Sepolia — OP Stack L2 testnet anchored on Ethereum Sepolia.
    "optimism-sepolia": {
      url: process.env.OPTIMISM_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts,
    },
  },
  // Etherscan verification — Etherscan migrated to a unified V2 API in
  // 2025; a single ETHERSCAN_API_KEY covers Sepolia, Base Sepolia, Polygon
  // Amoy, and Optimism Sepolia. Avalanche Fuji uses SnowTrace (separate key).
  // chainscan-galileo (0G) still uses the V1-style per-chain endpoint.
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "placeholder",
      "0g-testnet": process.env.ETHERSCAN_API_KEY || "placeholder",
      "base-sepolia": process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "placeholder",
      "avalanche-fuji": process.env.SNOWTRACE_API_KEY || "placeholder",
      "polygon-amoy": process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "placeholder",
      "optimism-sepolia": process.env.ETHERSCAN_API_KEY || "placeholder",
    },
    customChains: [
      {
        network: "0g-testnet",
        chainId: 16602,
        urls: {
          apiURL: "https://chainscan-galileo.0g.ai/open/api",
          browserURL: "https://chainscan-galileo.0g.ai",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "avalanche-fuji",
        chainId: 43113,
        urls: {
          apiURL: "https://api-testnet.snowtrace.io/api",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
      {
        network: "polygon-amoy",
        chainId: 80002,
        urls: {
          apiURL: "https://api-amoy.polygonscan.com/api",
          browserURL: "https://amoy.polygonscan.com",
        },
      },
      {
        network: "optimism-sepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api-sepolia-optimistic.etherscan.io/api",
          browserURL: "https://sepolia-optimistic.etherscan.io",
        },
      },
    ],
  },
};
