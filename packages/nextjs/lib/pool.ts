"use client";

import { useReadContract } from "wagmi";
import { LendingPoolAbi } from "../contracts/abis/LendingPool";
import { appConfig } from "./config";

/**
 * Typed-enough wrappers around the pool contract. Addresses stay undefined until
 * `npm run deploy` writes .env.local, so every read is disabled until configured.
 */
export function usePoolRead(functionName: string, args: readonly unknown[] = []) {
  return useReadContract({
    address: appConfig.pool,
    abi: LendingPoolAbi as unknown as readonly unknown[],
    functionName: functionName as never,
    args: args as never,
    query: { enabled: Boolean(appConfig.pool), refetchInterval: 15_000 },
  });
}

export function useErc20Read(address: `0x${string}` | undefined, functionName: string, args: readonly unknown[] = []) {
  return useReadContract({
    address,
    abi: [
      {
        inputs: [{ internalType: "address", name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [
          { internalType: "address", name: "owner", type: "address" },
          { internalType: "address", name: "spender", type: "address" },
        ],
        name: "allowance",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const,
    functionName: functionName as never,
    args: args as never,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
}
