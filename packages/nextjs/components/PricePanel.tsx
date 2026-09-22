"use client";

import { useState } from "react";
import { getPublicClient } from "wagmi/actions";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { pythAbi } from "../contracts/abis/pyth";
import { appConfig } from "../lib/config";
import { fetchPriceUpdate } from "../lib/hermes";
import { usePoolRead } from "../lib/pool";
import { config } from "../lib/wagmi";

export function PricePanel() {
  const { address } = useAccount();
  const { data: price } = usePoolRead("latestPrice18") as { data: bigint | undefined };
  const { writeContractAsync, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const updateData = await fetchPriceUpdate(appConfig.hbarUsdFeedId);
      const publicClient = getPublicClient(config);
      const fee = await publicClient.readContract({
        address: appConfig.pyth,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [updateData],
      });
      await writeContractAsync({
        address: appConfig.pool!,
        abi: LendingPoolAbi,
        functionName: "updatePrice",
        args: [updateData],
        value: fee,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-400">HBAR / USD</div>
        <div className="text-xl font-bold text-emerald-400">
          {price ? `$${formatUnits(price, 18)}` : "not updated yet"}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {error ? <span className="text-xs text-red-400">{error}</span> : null}
        <button
          onClick={refresh}
          disabled={!address || isPending || confirming}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending || confirming ? "Updating…" : "Update price (Pyth pull)"}
        </button>
      </div>
    </div>
  );
}
