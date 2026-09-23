import { formatUnits } from "viem";

export function fmtHbar(raw: bigint | undefined): string {
  if (raw === undefined) return "—";
  return `${Number(formatUnits(raw, 8)).toLocaleString(undefined, { maximumFractionDigits: 2 })} HBAR`;
}

export function fmtUsdx(raw: bigint | undefined): string {
  if (raw === undefined) return "—";
  return `${Number(formatUnits(raw, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDX`;
}

export function shorten(address: string | undefined): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function errMsg(e: unknown): string {
  const short = (e as { shortMessage?: string })?.shortMessage;
  return short ?? (e instanceof Error ? e.message : String(e));
}
