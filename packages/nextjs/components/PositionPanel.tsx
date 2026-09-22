"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { erc20Abi } from "../contracts/abis/erc20";
import { pythAbi } from "../contracts/abis/pyth";
import { parsePositiveAmount, tinybarToWeibar } from "../lib/amounts";
import { appConfig } from "../lib/config";
import { fetchPriceUpdate } from "../lib/hermes";
import { fmtHbar, fmtUsdx } from "../lib/format";
import { useErc20Read, usePoolRead } from "../lib/pool";
import { useMarketTransaction } from "../lib/useMarketTransaction";
import { TransactionStatus } from "./TransactionStatus";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none";

const btnCls =
  "rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

export function PositionPanel() {
  const transaction = useMarketTransaction();
  const { address, publicClient, writeContractAsync, execute, confirm, busy } =
    transaction;
  const pool = appConfig.pool!;
  const usdx = appConfig.usdxEvm!;
  const supplyRead = usePoolRead("supplyBalanceOf", [address]);
  const borrowRead = usePoolRead("borrowBalanceOf", [address]);
  const collateralRead = usePoolRead("collateralOf", [address]);
  const priceRead = usePoolRead("latestPrice18");
  const price = priceRead.data as bigint | undefined;
  const healthRead = usePoolRead(
    "healthFactorOf",
    [address, price],
    Boolean(price),
  );
  const walletRead = useErc20Read(usdx, "balanceOf", [address]);
  const supplyBal = supplyRead.data as bigint | undefined;
  const borrowBal = borrowRead.data as bigint | undefined;
  const collateral = collateralRead.data as bigint | undefined;
  const health = healthRead.data as bigint | undefined;
  const usdxBal = walletRead.data as bigint | undefined;
  const readError =
    supplyRead.error ??
    borrowRead.error ??
    collateralRead.error ??
    priceRead.error ??
    walletRead.error;
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

  const pythUpdate = async () => {
    const updateData = await fetchPriceUpdate(appConfig.hbarUsdFeedId);
    const fee = await publicClient.readContract({
      address: appConfig.pyth,
      abi: pythAbi,
      functionName: "getUpdateFee",
      args: [updateData],
    });
    return { updateData, value: tinybarToWeibar(fee) };
  };

  const approve = async (amount: bigint) => {
    const allowance = await publicClient.readContract({
      address: usdx,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, pool],
    });
    if (allowance < amount) {
      await confirm(
        await writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: usdx,
          abi: erc20Abi,
          functionName: "approve",
          args: [pool, amount],
        }),
      );
    }
  };

  const doSupply = () =>
    execute(
      async () => {
        const amount = parsePositiveAmount(supplyAmt, 6, "USDX");
        await approve(amount);
        return writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "supply",
          args: [amount],
        });
      },
      () => setSupplyAmt(""),
    );

  const doWithdrawSupply = () =>
    execute(
      () =>
        writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "withdrawSupply",
          args: [parsePositiveAmount(supplyAmt, 6, "USDX")],
        }),
      () => setSupplyAmt(""),
    );

  const doDepositCollateral = () =>
    execute(
      () =>
        writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "depositCollateral",
          value: tinybarToWeibar(parsePositiveAmount(collateralAmt, 8, "HBAR")),
        }),
      () => setCollateralAmt(""),
    );

  const doWithdrawCollateral = () =>
    execute(
      async () => {
        const amount = parsePositiveAmount(collateralAmt, 8, "HBAR");
        const debtShares = await publicClient.readContract({
          address: pool,
          abi: LendingPoolAbi,
          functionName: "borrowScaled",
          args: [address],
        });
        const { updateData, value } =
          debtShares === 0n
            ? { updateData: [] as `0x${string}`[], value: 0n }
            : await pythUpdate();
        return writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "withdrawCollateral",
          args: [amount, updateData],
          value,
        });
      },
      () => setCollateralAmt(""),
    );

  const doBorrow = () =>
    execute(
      async () => {
        const amount = parsePositiveAmount(borrowAmt, 6, "USDX");
        const { updateData, value } = await pythUpdate();
        return writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "borrow",
          args: [amount, updateData],
          value,
        });
      },
      () => setBorrowAmt(""),
    );

  const doRepay = () =>
    execute(
      async () => {
        const amount = parsePositiveAmount(borrowAmt, 6, "USDX");
        await approve(amount);
        return writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: pool,
          abi: LendingPoolAbi,
          functionName: "repay",
          args: [amount],
        });
      },
      () => setBorrowAmt(""),
    );

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
            <dt className="text-slate-400">Health factor (cached price)</dt>
            <dd
              className={`font-mono ${health !== undefined && health < 10n ** 18n ? "text-red-400" : "text-emerald-400"}`}
            >
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
            No USDX yet? Use the faucet below. New wallets also need to{" "}
            <strong>associate</strong> the USDX token (token id{" "}
            {appConfig.usdxTokenId ?? "—"}) in HashPack before receiving it, or
            run <code className="text-emerald-300">npm run associate</code> with
            your credentials.
          </p>
        ) : null}
      </section>

      {/* Supply side */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="mb-4 font-semibold">Supply / withdraw USDX</h3>
        <div className="space-y-3">
          <Field label="Amount (USDX)">
            <input
              inputMode="decimal"
              className={inputCls}
              value={supplyAmt}
              onChange={(e) => setSupplyAmt(e.target.value)}
              placeholder="1000"
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={doSupply}
              disabled={busy || !supplyAmt}
              className={`${btnCls} bg-emerald-600 text-white hover:bg-emerald-500`}
            >
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
              inputMode="decimal"
              className={inputCls}
              value={collateralAmt}
              onChange={(e) => setCollateralAmt(e.target.value)}
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
              Withdraw
            </button>
          </div>
        </div>
      </section>

      {/* Borrow side */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="mb-4 font-semibold">Borrow / repay USDX</h3>
        <div className="space-y-3">
          <Field label="Amount (USDX)">
            <input
              inputMode="decimal"
              className={inputCls}
              value={borrowAmt}
              onChange={(e) => setBorrowAmt(e.target.value)}
              placeholder="500"
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={doBorrow}
              disabled={busy || !borrowAmt}
              className={`${btnCls} bg-emerald-600 text-white hover:bg-emerald-500`}
            >
              Borrow
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
            Borrows and withdrawals with outstanding debt submit a fresh Pyth
            price update inside the transaction (pull oracle) and pay the small
            update fee in HBAR.
          </p>
        </div>
      </section>

      <div className="space-y-2 lg:col-span-3">
        {readError ? (
          <p role="alert" className="text-xs text-amber-300">
            Position data is temporarily unavailable. Balances are not
            confirmed; retry when the RPC is available.
          </p>
        ) : null}
        <p className="text-xs text-slate-500">
          Health uses the last price stored by the pool; it is not a live quote.
          Liquidation starts below 1.00 at the 80% threshold. New borrowing is
          limited to 75% of collateral value.
        </p>
        <TransactionStatus {...transaction} />
      </div>
    </div>
  );
}
