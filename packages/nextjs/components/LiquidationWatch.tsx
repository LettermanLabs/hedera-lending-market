"use client";

import { useCallback, useEffect, useState } from "react";
import { getPublicClient } from "wagmi/actions";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import type { Abi } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { erc20Abi } from "../contracts/abis/erc20";
import { pythAbi } from "../contracts/abis/pyth";
import { saucerSwapRouterAbi } from "../contracts/abis/saucerSwap";
import { reportActivity } from "../lib/activity";
import { appConfig } from "../lib/config";
import { fetchPriceUpdate } from "../lib/hermes";
import { fmtHbar, fmtUsdx, shorten } from "../lib/format";
import { fetchRecentBorrowers } from "../lib/mirror";
import { usePoolRead } from "../lib/pool";
import { config } from "../lib/wagmi";

const BONUS = 105n; // 5% liquidation bonus, /100
const SLIPPAGE_TOLERANCE = 97n; // 3% slippage on the SaucerSwap quote, /100

interface Row {
  account: `0x${string}`;
  debt?: bigint;
  collateral?: bigint;
  health?: bigint;
}

export function LiquidationWatch() {
  const { address } = useAccount();
  const pool = appConfig.pool!;
  const usdx = appConfig.usdxEvm!;
  const [rows, setRows] = useState<Row[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<`0x${string}` | null>(null);

  const { data: price } = usePoolRead("latestPrice18") as { data: bigint | undefined };
  const { writeContractAsync, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  const scan = useCallback(async () => {
    if (!pool) return;
    setScanning(true);
    setError(null);
    try {
      const borrowers = await fetchRecentBorrowers(appConfig.mirrorNode, pool);
      setRows(borrowers.map(account => ({ account })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, [pool]);

  useEffect(() => {
    scan();
  }, [scan]);

  const { data: positions } = useReadContracts({
    contracts: rows.flatMap(row => [
      { address: pool, abi: LendingPoolAbi as Abi, functionName: "borrowBalanceOf", args: [row.account] },
      { address: pool, abi: LendingPoolAbi as Abi, functionName: "collateralOf", args: [row.account] },
      { address: pool, abi: LendingPoolAbi as Abi, functionName: "healthFactorOf", args: [row.account, price ?? 0n] },
    ]),
    query: { enabled: rows.length > 0 && Boolean(price), refetchInterval: 15_000 },
  });

  useEffect(() => {
    if (!positions) return;
    setRows(prev =>
      prev.map((row, i) => ({
        ...row,
        debt: (positions[i * 3]?.result as bigint | undefined) ?? 0n,
        collateral: (positions[i * 3 + 1]?.result as bigint | undefined) ?? 0n,
        health: (positions[i * 3 + 2]?.result as bigint | undefined),
      })),
    );
  }, [positions]);

  const liquidate = async (row: Row) => {
    if (!row.debt || !price) return;
    setBusyAccount(row.account);
    setError(null);
    try {
      const publicClient = getPublicClient(config);

      // 1. Approve the pool to pull the repayment (full debt).
      const allowance = await publicClient.readContract({
        address: usdx,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address!, pool],
      });
      if ((allowance as bigint) < row.debt) {
        await writeContractAsync({ address: usdx, abi: erc20Abi, functionName: "approve", args: [pool, row.debt] });
      }

      // 2. Quote the SaucerSwap route for the collateral being seized.
      const seizeUsd18 = (row.debt * 10n ** 12n * BONUS) / 100n; // 6dp → 18dp
      const seizeWhbar = (seizeUsd18 * 10n ** 8n) / price;
      const amounts = await publicClient.readContract({
        address: appConfig.saucerSwapRouter,
        abi: saucerSwapRouterAbi,
        functionName: "getAmountsOut",
        args: [seizeWhbar, [appConfig.whbar, usdx]],
      });
      const minOut = ((amounts[1] as bigint) * SLIPPAGE_TOLERANCE) / 100n;

      // 3. Pull a fresh Pyth update and liquidate.
      const updateData = await fetchPriceUpdate(appConfig.hbarUsdFeedId);
      const fee = await publicClient.readContract({
        address: appConfig.pyth,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [updateData],
      });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const txHash = await writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "liquidate",
        args: [row.account, row.debt, minOut, deadline, updateData],
        value: fee,
      });
      reportActivity({ type: "liquidation", account: row.account, txHash });
      await scan();
    } catch (e) {
      setError(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e));
    } finally {
      setBusyAccount(null);
    }
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Liquidation watch</h3>
        <button
          onClick={scan}
          disabled={scanning}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Rescan borrowers"}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No borrowers found yet. Borrow against HBAR collateral to appear here.
        </p>
      ) : (
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
            {rows.map(row => {
              const liquidatable = row.health !== undefined && row.health < 10n ** 18n;
              return (
                <tr key={row.account} className="border-b border-slate-800/50">
                  <td className="py-2 pr-4 font-mono text-xs">{shorten(row.account)}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{fmtUsdx(row.debt)}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{fmtHbar(row.collateral)}</td>
                  <td
                    className={`py-2 pr-4 font-mono text-xs ${liquidatable ? "font-bold text-red-400" : "text-emerald-400"}`}
                  >
                    {row.health === undefined
                      ? "—"
                      : row.health > 10n ** 30n
                        ? "∞"
                        : Number(formatUnits(row.health, 18)).toFixed(2)}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => liquidate(row)}
                      disabled={!liquidatable || busyAccount !== null || isPending || confirming || !address}
                      className="rounded-lg bg-red-600/90 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busyAccount === row.account ? "Liquidating…" : "Liquidate"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Positions are found from pool events on the Hedera mirror node. A liquidation repays the debt, seizes 105% of
        its value in WHBAR collateral and swaps it back to USDX on SaucerSwap V1 — proceeds go to the liquidator.
      </p>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </section>
  );
}
