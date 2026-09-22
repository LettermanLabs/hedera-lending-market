/**
 * Frontend configuration. Everything is optional until `npm run deploy` writes
 * packages/nextjs/.env.local — the app boots without it and shows setup steps.
 */
const env = process.env;

export const appConfig = {
  network: env.NEXT_PUBLIC_NETWORK ?? "hedera-testnet",
  chainId: Number(env.NEXT_PUBLIC_CHAIN_ID ?? 296),
  rpcUrl: env.NEXT_PUBLIC_RPC_URL ?? "https://testnet.hashio.io/api",
  mirrorNode: env.NEXT_PUBLIC_MIRROR_NODE ?? "https://testnet.mirrornode.hedera.com",
  hashscan: "https://hashscan.io/testnet",

  /** LendingPool contract (EVM address) */
  pool: env.NEXT_PUBLIC_LENDING_POOL as `0x${string}` | undefined,
  /** USDX HTS token */
  usdxTokenId: env.NEXT_PUBLIC_USDX_TOKEN_ID,
  usdxEvm: env.NEXT_PUBLIC_USDX_EVM as `0x${string}` | undefined,
  /** SaucerSwap WHBAR (0.0.15058) */
  whbar: (env.NEXT_PUBLIC_WHBAR ?? "0x0000000000000000000000000000000000003ae2") as `0x${string}`,
  /** Pyth pull oracle on Hedera testnet */
  pyth: (env.NEXT_PUBLIC_PYTH ?? "0xa2aa501b19aff244d90cc15a4cf739d2725b5729") as `0x${string}`,
  hbarUsdFeedId:
    env.NEXT_PUBLIC_PYTH_FEED_ID ??
    "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd",
  /** SaucerSwap V1 router on Hedera testnet (0.0.19264) */
  saucerSwapRouter: (env.NEXT_PUBLIC_SAUCERSWAP_ROUTER ??
    "0x0000000000000000000000000000000000004b40") as `0x${string}`,
  /** HCS activity topic */
  hcsTopicId: env.NEXT_PUBLIC_HCS_TOPIC_ID,
};

export const isConfigured = Boolean(appConfig.pool && appConfig.usdxEvm);
