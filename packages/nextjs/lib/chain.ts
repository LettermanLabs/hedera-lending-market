import { defineChain } from "viem";
import { appConfig } from "./config";

/** Wallets and JSON-RPC use 18-decimal weibar; contract ABI amounts use tinybars. */
export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [appConfig.rpcUrl] } },
  blockExplorers: { default: { name: "HashScan", url: appConfig.hashscan } },
  testnet: true,
});
