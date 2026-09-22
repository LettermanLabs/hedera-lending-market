import * as dotenv from "dotenv";
import * as path from "path";
import { parsePrivateKey } from "./scripts/lib/setup";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";
import "@typechain/hardhat";
import { HardhatUserConfig } from "hardhat/config";

// Hedera mainnet fork (HTS-aware) for the SaucerSwap liquidation test — `npm run test:fork`.
if (process.env.HEDERA_FORKING === "true") {
  require("@hashgraph/system-contracts-forking/plugin");
}

dotenv.config({ path: path.join(__dirname, "../../.env") });

const deployerKey = process.env.HEDERA_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // forking config consumed by @hashgraph/system-contracts-forking (types extended at runtime)
      forking:
        process.env.HEDERA_FORKING === "true"
          ? {
              url: "https://mainnet.hashio.io/api",
              // @ts-expect-error - custom property for hedera-forking plugin
              chainId: 295,
              workerPort: 10001,
            }
          : undefined,
    },
    hederaTestnet: {
      url: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
      chainId: 296,
      accounts: deployerKey ? [`0x${parsePrivateKey(deployerKey).toStringRaw()}`] : [],
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
