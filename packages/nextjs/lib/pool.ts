"use client";

import { useReadContract } from "wagmi";
import type { Abi, ContractFunctionName } from "viem";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { erc20Abi } from "../contracts/abis/erc20";
import { appConfig } from "./config";

type PoolView = ContractFunctionName<typeof LendingPoolAbi, "pure" | "view">;

/** Reads stay disabled until the deployment and every argument are available. */
export function usePoolRead(
  functionName: PoolView,
  args: readonly unknown[] = [],
  enabled = true,
) {
  return useReadContract({
    address: appConfig.pool,
    abi: LendingPoolAbi as Abi,
    functionName,
    args,
    query: {
      enabled:
        enabled &&
        Boolean(appConfig.pool) &&
        args.every((arg) => arg !== undefined && arg !== null),
      refetchInterval: 15_000,
    },
  });
}

export function useErc20Read(
  address: `0x${string}` | undefined,
  functionName: "balanceOf" | "allowance",
  args: readonly unknown[] = [],
) {
  return useReadContract({
    address,
    abi: erc20Abi as Abi,
    functionName,
    args,
    query: {
      enabled:
        Boolean(address) &&
        args.every((arg) => arg !== undefined && arg !== null),
      refetchInterval: 15_000,
    },
  });
}
