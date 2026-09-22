import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { hederaTestnet } from "./chain";

/**
 * RainbowKit + wagmi config. A demo project id keeps the app bootable without
 * WalletConnect credentials; set NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID to enable
 * HashPack and other WalletConnect wallets.
 */
export const config = getDefaultConfig({
  appName: "Hedera Lending Market",
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "hedera-lending-market-demo",
  chains: [hederaTestnet],
  ssr: true,
});
