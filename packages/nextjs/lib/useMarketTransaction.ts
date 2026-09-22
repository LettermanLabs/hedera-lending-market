"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getPublicClient } from "wagmi/actions";
import { useAccount, useWriteContract } from "wagmi";
import type { Hash } from "viem";
import { reportActivity } from "./activity";
import { appConfig } from "./config";
import { errMsg } from "./format";
import { confirmTransaction } from "./transactions";
import { config } from "./wagmi";

export function useMarketTransaction() {
  const { address, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hash, setHash] = useState<Hash>();
  const publicClient = getPublicClient(config);

  const confirm = async (txHash: Hash) => {
    setHash(txHash);
    setMessage("Waiting for transaction confirmation…");
    return confirmTransaction(publicClient, txHash);
  };

  const execute = async (
    action: () => Promise<Hash>,
    afterSuccess?: () => void,
    mirrorActivity = true,
  ): Promise<void> => {
    if (active.current) return;
    if (!address || chainId !== appConfig.chainId) {
      setError("Connect your wallet to Hedera Testnet before continuing.");
      return;
    }
    active.current = true;
    setBusy(true);
    setError(null);
    setHash(undefined);
    setMessage("Preparing transaction. Follow the prompts in your wallet.");
    try {
      const confirmedHash = await confirm(await action());
      setHash(confirmedHash);
      setMessage("Transaction confirmed.");
      afterSuccess?.();
      await queryClient.invalidateQueries({ queryKey: ["readContract"] });
      await queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      const warning = mirrorActivity
        ? await reportActivity(confirmedHash)
        : null;
      if (warning) setMessage(warning);
    } catch (e) {
      setError(errMsg(e));
      setMessage(null);
    } finally {
      active.current = false;
      setBusy(false);
    }
  };

  return {
    address,
    chainId,
    writeContractAsync,
    execute,
    confirm,
    publicClient,
    busy,
    error,
    message,
    hash,
  };
}
