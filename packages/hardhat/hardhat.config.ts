import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";
import "@typechain/hardhat";
import { HardhatUserConfig } from "hardhat/config";

dotenv.config({ path: "../../.env" });

const deployerKey = process.env.HEDERA_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    hederaTestnet: {
      url: process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api",
      chainId: 296,
      accounts: deployerKey ? [deployerKey] : [],
      gas: 2_000_000,
    },
    hederaMainnet: {
      url: process.env.HEDERA_RPC_URL ?? "https://mainnet.hashio.io/api",
      chainId: 295,
      accounts: deployerKey ? [deployerKey] : [],
      gas: 2_000_000,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
