"use client";

import { useState } from "react";
import { getPublicClient } from "wagmi/actions";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { erc20Abi } from "../contracts/abis/erc20";
import { pythAbi } from "../contracts/abis/pyth";
import { reportActivity } from "../lib/activity";
import { appConfig } from "../lib/config";
import { fetchPriceUpdate } from "../lib/hermes";
import { errMsg, fmtHbar, fmtUsdx } from "../lib/format";
import { useErc20Read, usePoolRead } from "../lib/pool";
import { config } from "../lib/wagmi";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none";

const btnCls =
  "rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

export function PositionPanel() {
  const { address } = useAccount();
  const pool = appConfig.pool!;
  const usdx = appConfig.usdxEvm!;

  const { data: supplyBal } = usePoolRead("supplyBalanceOf", [address]) as { data: bigint | undefined };
  const { data: borrowBal } = usePoolRead("borrowBalanceOf", [address]) as { data: bigint | undefined };
  const { data: collateral } = usePoolRead("collateralOf", [address]) as { data: bigint | undefined };
  const { data: price } = usePoolRead("latestPrice18") as { data: bigint | undefined };
  const { data: health } = usePoolRead("healthFactorOf", [address, price ?? 0n]) as {
    data: bigint | undefined;
  };
  const { data: usdxBal } = useErc20Read(usdx, "balanceOf", [address]) as { data: bigint | undefined };
  const { data: allowance } = useErc20Read(usdx, "allowance", [address, pool]) as {
    data: bigint | undefined;
  };

  const { writeContractAsync, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });
  const busy = isPending || confirming;
  const [error, setError] = useState<string | null>(null);
  const [supplyAmt, setSupplyAmt] = useState("");
  const [collateralAmt, setCollateralAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");

  if (!address) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
        Connect a wallet to manage your position.
      </div>
    );
  }

  /** Builds a Pyth pull-oracle payload + fee for the given entry point. */
  const pythUpdate = async () => {
    const updateData = await fetchPriceUpdate(appConfig.hbarUsdFeedId);
    const publicClient = getPublicClient(config);
    const fee = await publicClient.readContract({
      address: appConfig.pyth,
      abi: pythAbi,
      functionName: "getUpdateFee",
      args: [updateData],
    });
    return { updateData, fee };
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      const txHash = await fn();
      if (typeof txHash === "string") {
        reportActivity({ type: "tx", account: address, txHash });
      }
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const doSupply = () =>
    run(async () => {
      const amount = parseUnits(supplyAmt, 6);
      if ((allowance ?? 0n) < amount) {
        await writeContractAsync({ address: usdx, abi: erc20Abi, functionName: "approve", args: [pool, amount] });
      }
      return writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "supply",
        args: [amount],
      });
    });

  const doWithdrawSupply = () =>
    run(() =>
      writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "withdrawSupply",
        args: [parseUnits(supplyAmt, 6)],
      }),
    );

  const doDepositCollateral = () =>
    run(() =>
      writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "depositCollateral",
        value: parseUnits(collateralAmt, 8),
      }),
    );

  const doWithdrawCollateral = () =>
    run(async () => {
      const { updateData, fee } = await pythUpdate();
      return writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "withdrawCollateral",
        args: [parseUnits(collateralAmt, 8), updateData],
        value: fee,
      });
    });

  const doBorrow = () =>
    run(async () => {
      const { updateData, fee } = await pythUpdate();
      return writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "borrow",
        args: [parseUnits(borrowAmt, 6), updateData],
        value: fee,
      });
    });

  const doRepay = () =>
    run(async () => {
      const amount = parseUnits(borrowAmt, 6);
      if ((allowance ?? 0n) < amount) {
        await writeContractAsync({ address: usdx, abi: erc20Abi, functionName: "approve", args: [pool, amount] });
      }
      return writeContractAsync({
        address: pool,
        abi: LendingPoolAbi,
        functionName: "repay",
        args: [amount],
      });
    });

  const healthLabel =
    health === undefined
      ? "—"
      : health === 2n ** 256n - 1n
        ? "∞"
        : Number(formatUnits(health, 18)).toFixed(2);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Position summary */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="mb-4 font-semibold">Your position</h3>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-400">USDX supplied</dt>
            <dd className="font-mono">{fmtUsdx(supplyBal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">USDX borrowed</dt>
            <dd className="font-mono">{fmtUsdx(borrowBal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">HBAR collateral</dt>
            <dd className="font-mono">{fmtHbar(collateral)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">Health factor</dt>
            <dd className={`font-mono ${health !== undefined && health < 10n ** 18n ? "text-red-400" : "text-emerald-400"}`}>
              {healthLabel}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">USDX wallet balance</dt>
            <dd className="font-mono">{fmtUsdx(usdxBal)}</dd>
          </div>
        </dl>
        {usdxBal === 0n ? (
          <p className="mt-4 rounded-lg bg-slate-800/60 p-3 text-xs leading-relaxed text-slate-400">
            No USDX yet? Use the faucet below. New wallets also need to <strong>associate</strong> the USDX token
            (token id {appConfig.usdxTokenId ?? "—"}) in HashPack before receiving it, or run{" "}
            <code className="text-emerald-300">npm run associate</code> with your credentials.
          </p>
        ) : null}
      </section>

      {/* Supply side */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="mb-4 font-semibold">Supply / withdraw USDX</h3>
        <div className="space-y-3">
          <Field label="Amount (USDX)">
            <input className={inputCls} value={supplyAmt} onChange={e => setSupplyAmt(e.target.value)} placeholder="1000" />
          </Field>
          <div className="flex gap-2">
            <button onClick={doSupply} disabled={busy || !supplyAmt} className={`${btnCls} bg-emerald-600 text-white hover:bg-emerald-500`}>
              Supply
            </button>
            <button
              onClick={doWithdrawSupply}
              disabled={busy || !supplyAmt}
              className={`${btnCls} border border-slate-700 text-slate-200 hover:bg-slate-800`}
            >
              Withdraw
            </button>
          </div>
        </div>

        <hr className="my-5 border-slate-800" />

        <h3 className="mb-4 font-semibold">HBAR collateral</h3>
        <div className="space-y-3">
          <Field label="Amount (HBAR)">
            <input
              className={inputCls}
              value={collateralAmt}
              onChange={e => setCollateralAmt(e.target.value)}
              placeholder="100"
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={doDepositCollateral}
              disabled={busy || !collateralAmt}
              className={`${btnCls} bg-emerald-600 text-white hover:bg-emerald-500`}
            >
              Deposit
            </button>
            <button
              onClick={doWithdrawCollateral}
              disabled={busy || !collateralAmt}
              className={`${btnCls} border border-slate-700 text-slate-200 hover:bg-slate-800`}
            >
              Withdraw (Pyth update)
            </button>
          </div>
        </div>
      </section>

      {/* Borrow side */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="mb-4 font-semibold">Borrow / repay USDX</h3>
        <div className="space-y-3">
          <Field label="Amount (USDX)">
            <input className={inputCls} value={borrowAmt} onChange={e => setBorrowAmt(e.target.value)} placeholder="500" />
          </Field>
          <div className="flex gap-2">
            <button onClick={doBorrow} disabled={busy || !borrowAmt} className={`${btnCls} bg-emerald-600 text-white hover:bg-emerald-500`}>
              Borrow (Pyth update)
            </button>
            <button
              onClick={doRepay}
              disabled={busy || !borrowAmt}
              className={`${btnCls} border border-slate-700 text-slate-200 hover:bg-slate-800`}
            >
              Repay
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Borrows and collateral withdrawals submit a fresh Pyth price update inside the transaction (pull oracle)
            and pay the small update fee in HBAR.
          </p>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300 lg:col-span-3">
          {error}
        </div>
      ) : null}
    </div>
  );
}
