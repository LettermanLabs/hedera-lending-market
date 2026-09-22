import { parseUnits } from "viem";

/** Hedera contract values use tinybars; JSON-RPC transaction values use weibar. */
export function tinybarToWeibar(tinybar: bigint): bigint {
  if (tinybar < 0n) throw new Error("HBAR amount cannot be negative.");
  return tinybar * 10n ** 10n;
}

export function parsePositiveAmount(
  input: string,
  decimals: number,
  asset: string,
): bigint {
  const value = input.trim();
  if (value.length > 100 || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Enter a positive ${asset} amount.`);
  }
  if ((value.split(".")[1]?.length ?? 0) > decimals) {
    throw new Error(`${asset} supports at most ${decimals} decimal places.`);
  }
  const amount = parseUnits(value, decimals);
  if (amount <= 0n)
    throw new Error(`Enter a ${asset} amount greater than zero.`);
  return amount;
}

export function pythPrice18(price: string, exponent: number): bigint {
  if (
    !/^\d+$/.test(price) ||
    !Number.isInteger(exponent) ||
    exponent < -18 ||
    exponent > 18
  ) {
    throw new Error("The price service returned an invalid HBAR price.");
  }
  const result = BigInt(price) * 10n ** BigInt(18 + exponent);
  if (result <= 0n) throw new Error("The HBAR price must be positive.");
  return result;
}

/** A fixed 3% minimum-output tolerance, rounded down in USDX base units. */
export function minimumSwapOutput(quoted: bigint): bigint {
  if (quoted <= 0n) throw new Error("The swap route returned no USDX output.");
  const minimum = (quoted * 97n) / 100n;
  if (minimum === 0n)
    throw new Error("The liquidation is too small to quote safely.");
  return minimum;
}
