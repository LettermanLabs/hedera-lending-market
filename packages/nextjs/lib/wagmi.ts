import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { http } from "wagmi";
import { hederaTestnet } from "./chain";

const projectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID?.trim();

// Enable WalletConnect only when a project ID is configured.
export const config = getDefaultConfig({
  appName: "Hedera Lending Market",
  projectId: projectId ?? "injected-only",
  wallets: projectId
    ? undefined
    : [{ groupName: "Browser wallets", wallets: [injectedWallet] }],
  chains: [hederaTestnet],
  transports: { [hederaTestnet.id]: http() },
  ssr: true,
});
