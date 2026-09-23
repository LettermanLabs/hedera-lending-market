import { isAddress } from "viem";

// Keep public env reads explicit: Next.js replaces these at build time.
const pool = process.env.NEXT_PUBLIC_LENDING_POOL;
const usdx = process.env.NEXT_PUBLIC_USDX_EVM;

export const appConfig = {
  network: "hedera-testnet",
  chainId: 296,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://testnet.hashio.io/api",
  mirrorNode:
    process.env.NEXT_PUBLIC_MIRROR_NODE ||
    "https://testnet.mirrornode.hedera.com",
  hashscan: "https://hashscan.io/testnet",
  pool: pool && isAddress(pool) ? pool : undefined,
  usdxTokenId: process.env.NEXT_PUBLIC_USDX_TOKEN_ID,
  usdxEvm: usdx && isAddress(usdx) ? usdx : undefined,
  whbar: (process.env.NEXT_PUBLIC_WHBAR ||
    "0x0000000000000000000000000000000000003ae2") as `0x${string}`,
  pyth: (process.env.NEXT_PUBLIC_PYTH ||
    "0xa2aa501b19aff244d90cc15a4cf739d2725b5729") as `0x${string}`,
  hbarUsdFeedId:
    process.env.NEXT_PUBLIC_PYTH_FEED_ID ||
    "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd",
  saucerSwapRouter: (process.env.NEXT_PUBLIC_SAUCERSWAP_ROUTER ||
    "0x0000000000000000000000000000000000004b40") as `0x${string}`,
  hcsTopicId: process.env.NEXT_PUBLIC_HCS_TOPIC_ID,
  ammPair: process.env.NEXT_PUBLIC_AMM_PAIR,
};

export const isConfigured = Boolean(appConfig.pool && appConfig.usdxEvm);
export const configurationError =
  (pool && !isAddress(pool)) || (usdx && !isAddress(usdx))
    ? "The configured pool or USDX address is invalid. Check packages/nextjs/.env.local and restart the app."
    : null;
