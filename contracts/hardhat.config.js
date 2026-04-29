require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

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
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  // Etherscan verification — Etherscan migrated to a unified V2 API in
  // 2025; the `apiKey` is now a single string used for any chain
  // Etherscan V2 covers (incl. Sepolia). chainscan-galileo (0G) still
  // uses the V1-style per-chain endpoint, kept here as a customChain.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "placeholder",
    customChains: [
      {
        network: "0g-testnet",
        chainId: 16602,
        urls: {
          apiURL: "https://chainscan-galileo.0g.ai/open/api",
          browserURL: "https://chainscan-galileo.0g.ai",
        },
      },
    ],
  },
};
