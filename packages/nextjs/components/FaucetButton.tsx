"use client";

import { useState } from "react";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { reportActivity } from "../lib/activity";
import { appConfig } from "../lib/config";
import { errMsg } from "../lib/format";

export function FaucetButton() {
  const { address } = useAccount();
  const { writeContractAsync, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const claim = async () => {
    setError(null);
    try {
      const txHash = await writeContractAsync({
        address: appConfig.pool!,
        abi: LendingPoolAbi,
        functionName: "claimFaucet",
      });
      setDone(true);
      reportActivity({ type: "faucet", account: address, txHash });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-700 p-4">
      <div className="text-sm">
        <span className="font-semibold text-slate-200">Testnet faucet</span>
        <p className="text-xs text-slate-500">Claim 250 USDX once per hour (needs the USDX token associated).</p>
      </div>
      <button
        onClick={claim}
        disabled={!address || isPending || confirming}
        className="ml-auto rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending || confirming ? "Claiming…" : done ? "Claim again later" : "Claim 250 USDX"}
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}
