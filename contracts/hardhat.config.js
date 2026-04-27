require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
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
  },
  // chainscan-galileo accepts an Etherscan-compatible verification API.
  // The API key is optional on testnet — placeholder works if CHAINSCAN_API_KEY is unset.
  etherscan: {
    apiKey: {
      "0g-testnet": process.env.CHAINSCAN_API_KEY || "placeholder",
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
    ],
  },
};
