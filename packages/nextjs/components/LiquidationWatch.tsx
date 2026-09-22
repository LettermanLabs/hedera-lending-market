"use client";

import { useCallback, useEffect, useState } from "react";
import { useReadContracts } from "wagmi";
import { formatUnits, maxUint256 } from "viem";
import type { Abi } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { erc20Abi } from "../contracts/abis/erc20";
import { pythAbi } from "../contracts/abis/pyth";
import { saucerSwapRouterAbi } from "../contracts/abis/saucerSwap";
import { minimumSwapOutput, tinybarToWeibar } from "../lib/amounts";
import { appConfig } from "../lib/config";
import { fetchPriceSnapshot } from "../lib/hermes";
import { errMsg, fmtHbar, fmtUsdx, shorten } from "../lib/format";
import { fetchRecentBorrowers } from "../lib/mirror";
import { usePoolRead } from "../lib/pool";
import { useMarketTransaction } from "../lib/useMarketTransaction";
import { TransactionStatus } from "./TransactionStatus";

export function LiquidationWatch() {
  const pool = appConfig.pool!;
  const usdx = appConfig.usdxEvm!;
  const [borrowers, setBorrowers] = useState<`0x${string}`[]>([]);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const transaction = useMarketTransaction();
  const { address, publicClient, writeContractAsync, execute, confirm, busy } =
    transaction;
  const { data: cachedPrice } = usePoolRead("latestPrice18");
  const price = cachedPrice as bigint | undefined;

  const scan = useCallback(
    async (signal?: AbortSignal) => {
      if (!pool) return;
      setScanning(true);
      setScanError(null);
      try {
        const accounts = await fetchRecentBorrowers(
          appConfig.mirrorNode,
          pool,
          signal,
        );
        if (!signal?.aborted) setBorrowers(accounts);
      } catch (e) {
        if (!signal?.aborted) setScanError(errMsg(e));
      } finally {
        if (!signal?.aborted) setScanning(false);
      }
    },
    [pool],
  );

  useEffect(() => {
    const controller = new AbortController();
    void scan(controller.signal);
    return () => controller.abort();
  }, [scan]);

  const {
    data: positions,
    error: positionsError,
    isFetching,
  } = useReadContracts({
    contracts: borrowers.flatMap((account) => [
      {
        address: pool,
        abi: LendingPoolAbi as Abi,
        functionName: "borrowBalanceOf",
        args: [account],
      },
      {
        address: pool,
        abi: LendingPoolAbi as Abi,
        functionName: "collateralOf",
        args: [account],
      },
      {
        address: pool,
        abi: LendingPoolAbi as Abi,
        functionName: "healthFactorOf",
        args: [account, price ?? 0n],
      },
    ]),
    query: {
      enabled: borrowers.length > 0 && Boolean(price),
      refetchInterval: 15_000,
    },
  });
  const rows = borrowers
    .map((account, index) => ({
      account,
      debt: positions?.[index * 3]?.result as bigint | undefined,
      collateral: positions?.[index * 3 + 1]?.result as bigint | undefined,
      health: positions?.[index * 3 + 2]?.result as bigint | undefined,
      failed: positions
        ?.slice(index * 3, index * 3 + 3)
        .some((result) => result.status === "failure"),
    }))
    .filter((row) => row.debt !== 0n);

  const liquidate = (borrower: `0x${string}`) =>
    execute(
      async () => {
        // previewLiquidation shares the contract's rounding and collateral cap.
        const preview = async () => {
          const snapshot = await fetchPriceSnapshot(appConfig.hbarUsdFeedId);
          const liquidatable = await publicClient.readContract({
            address: pool,
            abi: LendingPoolAbi,
            functionName: "isLiquidatable",
            args: [borrower, snapshot.price18],
          });
          if (!liquidatable)
            throw new Error(
              "This position is healthy at the latest price. No liquidation was sent.",
            );
          const [pay, seizeHbar] = await publicClient.readContract({
            address: pool,
            abi: LendingPoolAbi,
            functionName: "previewLiquidation",
            args: [borrower, maxUint256, snapshot.price18],
          });
          if (pay <= 0n || seizeHbar <= 0n)
            throw new Error("This position has no repayable collateral.");
          return { ...snapshot, pay, seizeHbar };
        };
        let quote = await preview();
        const allowance = await publicClient.readContract({
          address: usdx,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address!, pool],
        });
        if (allowance < quote.pay) {
          await confirm(
            await writeContractAsync({
              account: address,
              chainId: appConfig.chainId,
              address: usdx,
              abi: erc20Abi,
              functionName: "approve",
              args: [pool, quote.pay],
            }),
          );
          // Approval can outlast the oracle freshness window. Refresh everything after it.
          quote = await preview();
          const confirmedAllowance = await publicClient.readContract({
            address: usdx,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address!, pool],
          });
          if (confirmedAllowance < quote.pay)
            throw new Error(
              "The repayment changed while approving. Review the updated position and try again.",
            );
        }
        const [amounts, fee, block] = await Promise.all([
          publicClient.readContract({
            address: appConfig.saucerSwapRouter,
            abi: saucerSwapRouterAbi,
            functionName: "getAmountsOut",
            args: [quote.seizeHbar, [appConfig.whbar, usdx]],
          }),
          publicClient.readContract({
            address: appConfig.pyth,
            abi: pythAbi,
            functionName: "getUpdateFee",
            args: [quote.updateData],
          }),
          publicClient.getBlock(),
        ]);
        if (amounts.length !== 2)
          throw new Error("The SaucerSwap route returned an invalid quote.");
        return writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "liquidate",
          args: [
            borrower,
            quote.pay,
            minimumSwapOutput(amounts[1]),
            block.timestamp + 300n,
            quote.updateData,
          ],
          value: tinybarToWeibar(fee),
        });
      },
      () => {
        void scan();
      },
    );

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Liquidation watch</h3>
        <button
          onClick={() => {
            void scan();
          }}
          disabled={scanning || busy}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Rescan borrowers"}
        </button>
      </div>
      {!appConfig.ammPair ? (
        <p className="text-xs text-amber-300">
          No funded SaucerSwap pair is configured. Live liquidations are
          unavailable. The README documents the forked-mainnet integration and
          test command.
        </p>
      ) : null}
      {scanError ? (
        <p role="alert" className="text-xs text-red-300">
          Borrower scan failed: {scanError}. The list may be incomplete.
        </p>
      ) : null}
      {positionsError || rows.some((row) => row.failed) ? (
        <p role="alert" className="text-xs text-amber-300">
          Some position reads failed. Unknown balances are shown as — and cannot
          be liquidated.
        </p>
      ) : null}
      {!price ? (
        <p className="text-xs text-slate-400">
          Update the pool price to load position health.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          {scanning || isFetching
            ? "Loading positions…"
            : scanError
              ? "Borrower data is unavailable."
              : "No outstanding borrowers found."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4">Account</th>
                <th className="py-2 pr-4">Debt</th>
                <th className="py-2 pr-4">Collateral</th>
                <th className="py-2 pr-4">Health</th>
                <th className="py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const unhealthy =
                  row.health !== undefined && row.health < 10n ** 18n;
                return (
                  <tr
                    key={row.account}
                    className="border-b border-slate-800/50"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">
                      {shorten(row.account)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {fmtUsdx(row.debt)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {fmtHbar(row.collateral)}
                    </td>
                    <td
                      className={`py-2 pr-4 font-mono text-xs ${unhealthy ? "text-red-400" : "text-slate-300"}`}
                    >
                      {row.health === undefined
                        ? "—"
                        : row.health === maxUint256
                          ? "∞"
                          : Number(formatUnits(row.health, 18)).toFixed(2)}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => {
                          void liquidate(row.account);
                        }}
                        disabled={
                          !row.debt ||
                          !row.collateral ||
                          !appConfig.ammPair ||
                          row.failed ||
                          busy ||
                          !address
                        }
                        className="rounded-lg bg-red-600/90 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {busy ? "Working…" : "Check & liquidate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500">
        Health uses the cached pool price. Liquidation rechecks a fresh signed
        price, caps repayment to collateral, and allows 3% swap slippage.
        Swapped USDX goes to the liquidator; profitability is not guaranteed.
      </p>
      <TransactionStatus {...transaction} />
    </section>
  );
}
