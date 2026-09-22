"use client";

import { formatUnits } from "viem";
import { usePoolRead } from "../lib/pool";
import { fmtUsdx, fmtUsd18 } from "../lib/format";
import { StatCard } from "./StatCard";

export function MarketStats() {
  const { data: totalSupply } = usePoolRead("totalSupply") as { data: bigint | undefined };
  const { data: totalBorrow } = usePoolRead("totalBorrow") as { data: bigint | undefined };
  const { data: reserves } = usePoolRead("totalReserves") as { data: bigint | undefined };
  const { data: price } = usePoolRead("latestPrice18") as { data: bigint | undefined };

  const utilization =
    totalSupply && totalSupply > 0n && totalBorrow !== undefined
      ? `${((Number(totalBorrow) / Number(totalSupply)) * 100).toFixed(1)}%`
      : "—";

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <StatCard label="Total supplied" value={fmtUsdx(totalSupply)} hint="USDX" />
      <StatCard label="Total borrowed" value={fmtUsdx(totalBorrow)} hint="USDX" />
      <StatCard label="Utilization" value={utilization} />
      <StatCard label="Protocol reserves" value={fmtUsdx(reserves)} hint="USDX" />
      <StatCard
        label="HBAR / USD (Pyth)"
        value={price ? `$${formatUnits(price, 18)}` : "—"}
        hint="pull oracle, refreshed on tx"
      />
    </div>
  );
}
