"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { pythAbi } from "../contracts/abis/pyth";
import { tinybarToWeibar } from "../lib/amounts";
import { appConfig } from "../lib/config";
import { fetchPriceUpdate } from "../lib/hermes";
import { usePoolRead } from "../lib/pool";
import { useMarketTransaction } from "../lib/useMarketTransaction";
import { TransactionStatus } from "./TransactionStatus";

export function PricePanel() {
  const { data, error: readError } = usePoolRead("latestPrice18");
  const price = data as bigint | undefined;
  const { data: published } = usePoolRead("latestPricePublishTime");
  const [now, setNow] = useState<number>();
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      10_000,
    );
    return () => clearInterval(timer);
  }, []);
  const age =
    now && published ? Math.max(0, now - Number(published)) : undefined;
  const transaction = useMarketTransaction();
  const { address, publicClient, execute, writeContractAsync, busy } =
    transaction;
  const refresh = () =>
    execute(
      async () => {
        const updateData = await fetchPriceUpdate(appConfig.hbarUsdFeedId);
        const fee = await publicClient.readContract({
          address: appConfig.pyth,
          abi: pythAbi,
          functionName: "getUpdateFee",
          args: [updateData],
        });
        return writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: appConfig.pool!,
          abi: LendingPoolAbi,
          functionName: "updatePrice",
          args: [updateData],
          value: tinybarToWeibar(fee),
        });
      },
      undefined,
      false,
    );

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">
            HBAR / USD · last stored price
          </div>
          <div className="text-xl font-bold text-emerald-400">
            {readError
              ? "Price unavailable"
              : price
                ? `$${formatUnits(price, 18)}`
                : "Not updated yet"}
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={!address || busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Updating…" : "Update price"}
        </button>
      </div>
      {age !== undefined ? (
        <p
          className={`text-xs ${age > 120 ? "text-amber-300" : "text-slate-400"}`}
        >
          Stored price is {age} seconds old
          {age > 120 ? "; refresh it before relying on displayed health." : "."}
        </p>
      ) : null}
      <p className="text-xs text-slate-500">
        Borrowing, withdrawals with debt and liquidation each request a fresh
        signed price. An unavailable price service will block those actions.
      </p>
      <TransactionStatus {...transaction} />
    </div>
  );
}
