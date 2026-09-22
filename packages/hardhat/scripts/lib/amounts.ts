/** Contract HBAR quantities use tinybars (8dp); JSON-RPC value uses 18dp. */
export const WEIBAR_PER_TINYBAR = 10n ** 10n;

export function priceUsd18(price: string, expo: number): bigint {
  if (!/^[1-9][0-9]*$/.test(price) || !Number.isInteger(expo) || expo < -18 || expo > 18) {
    throw new Error("Invalid positive HBAR/USD price or exponent");
  }
  return BigInt(price) * 10n ** BigInt(18 + expo);
}

export function bootstrapAmounts(value18: bigint, price: string, expo: number) {
  if (value18 <= 0n || value18 % WEIBAR_PER_TINYBAR !== 0n) {
    throw new Error("HBAR seed must be positive and a whole number of tinybars");
  }
  const usdx6 = (value18 * priceUsd18(price, expo)) / 10n ** 30n;
  if (usdx6 === 0n) throw new Error("USDX seed rounds to zero");
  return { value18, hbar8: value18 / WEIBAR_PER_TINYBAR, usdx6 };
}

/** Factory fees are tinycents (USD / 1e10); round up to a whole tinybar. */
export function tinycentsToRpcValue(fee: bigint, price: string, expo: number): bigint {
  const usd18 = priceUsd18(price, expo);
  const tinybars = (fee * 10n ** 16n + usd18 - 1n) / usd18;
  return tinybars * WEIBAR_PER_TINYBAR;
}
