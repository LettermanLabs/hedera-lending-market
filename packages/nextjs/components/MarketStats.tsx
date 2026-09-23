"use client";

import { formatUnits } from "viem";
import { usePoolRead } from "../lib/pool";
import { fmtUsdx } from "../lib/format";
import { StatCard } from "./StatCard";

export function MarketStats() {
  const supplyRead = usePoolRead("totalSupply");
  const totalSupply = supplyRead.data as bigint | undefined;
  const { data: totalBorrow } = usePoolRead("totalBorrow") as {
    data: bigint | undefined;
  };
  const { data: reserves } = usePoolRead("totalReserves") as {
    data: bigint | undefined;
  };
  const { data: available } = usePoolRead("availableLiquidity") as {
    data: bigint | undefined;
  };
  const { data: price } = usePoolRead("latestPrice18") as {
    data: bigint | undefined;
  };

  const utilization =
    totalSupply && totalSupply > 0n && totalBorrow !== undefined
      ? `${((Number(totalBorrow) / Number(totalSupply)) * 100).toFixed(1)}%`
      : "—";

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
      {supplyRead.error ? (
        <p
          role="alert"
          className="col-span-2 text-xs text-amber-300 lg:col-span-6"
        >
          Market data is unavailable. Check the configured contract and RPC
          connection.
        </p>
      ) : null}
      <StatCard label="Total supplied" value={fmtUsdx(totalSupply)} />
      <StatCard label="Total borrowed" value={fmtUsdx(totalBorrow)} />
      <StatCard label="Utilization" value={utilization} />
      <StatCard label="Available to borrow" value={fmtUsdx(available)} />
      <StatCard label="Protocol reserves" value={fmtUsdx(reserves)} />
      <StatCard
        label="HBAR / USD (Pyth)"
        value={price ? `$${formatUnits(price, 18)}` : "—"}
        hint="pull oracle, refreshed on tx"
      />
    </div>
  );
}
