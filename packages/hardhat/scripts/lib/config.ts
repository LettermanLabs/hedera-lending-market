/** Canonical Hedera testnet addresses for the template's ecosystem integrations.
 *  Every address here was verified against the Hedera mirror node / official docs:
 *  - Pyth:        docs.pyth.network EVM contract addresses (Hedera testnet 0.0.3042133)
 *  - SaucerSwap:  docs.saucerswap.finance contract deployments (testnet V1 router 0.0.19264)
 *  - WHBAR:       SaucerSwap wrapped HBAR (testnet 0.0.15058)
 */
export const TESTNET = {
  chainId: 296,
  rpcUrl: "https://testnet.hashio.io/api",
  mirrorNode: "https://testnet.mirrornode.hedera.com",
  hashscan: "https://hashscan.io/testnet",
  pyth: "0xa2aa501b19aff244d90cc15a4cf739d2725b5729",
  hbarUsdPriceId: "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd",
  saucerSwapRouter: "0x0000000000000000000000000000000000004b40", // 0.0.19264 (V1)
  whbar: "0x0000000000000000000000000000000000003ae2", // 0.0.15058
} as const;

export const USDX_DECIMALS = 6;
export const USDX_TOTAL_SUPPLY = 1_000_000n * 10n ** 6n;
export const POOL_LIQUIDITY_USDX = 400_000n * 10n ** 6n;
export const FAUCET_SEED_USDX = 100_000n * 10n ** 6n;
/** 100 HBAR of initial AMM liquidity, in wei (1 HBAR = 1e18 wei on the EVM). */
export const AMM_SEED_HBAR_WEI = 100n * 10n ** 18n;

/** Convert a Hedera token/account id (0.0.N) to its long-zero EVM address. */
export function idToEvmAddress(id: string): string {
  const num = BigInt(id.split(".").pop()!);
  return ("0x" + num.toString(16).padStart(40, "0")) as `0x${string}`;
}
