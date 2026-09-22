"use client";

import { useState } from "react";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { appConfig } from "../lib/config";
import { useMarketTransaction } from "../lib/useMarketTransaction";
import { TransactionStatus } from "./TransactionStatus";

export function FaucetButton() {
  const transaction = useMarketTransaction();
  const { address, writeContractAsync, execute, busy } = transaction;
  const [claimedAddress, setClaimedAddress] = useState<string>();
  const claim = () =>
    execute(
      () =>
        writeContractAsync({
          account: address,
          chainId: appConfig.chainId,
          address: appConfig.pool!,
          abi: LendingPoolAbi,
          functionName: "claimFaucet",
        }),
      () => setClaimedAddress(address),
    );

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-slate-700 p-4">
      <div className="flex items-center gap-3">
        <div className="text-sm">
          <span className="font-semibold text-slate-200">Testnet faucet</span>
          <p className="text-xs text-slate-500">
            Claim 250 USDX once per hour. Associate the USDX token in your
            wallet first.
          </p>
        </div>
        <button
          onClick={claim}
          disabled={!address || busy}
          className="ml-auto rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Claiming…"
            : address && claimedAddress === address
              ? "Claim again later"
              : "Claim 250 USDX"}
        </button>
      </div>
      <TransactionStatus {...transaction} />
    </div>
  );
}
