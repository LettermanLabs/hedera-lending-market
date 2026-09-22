import * as dotenv from "dotenv";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { TESTNET } from "./config";

// Scripts run from packages/hardhat (npm workspace); the repo-root .env is two levels up.
dotenv.config({ path: "../../.env" });

export function requireEnv(): { accountId: AccountId; operatorKey: PrivateKey; accountIdString: string } {
  const accountIdString = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  if (!accountIdString || !privateKey) {
    throw new Error("Missing HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY. Copy .env.example to .env in the repo root and fill it in.");
  }
  return {
    accountIdString,
    accountId: AccountId.fromString(accountIdString),
    operatorKey: PrivateKey.fromString(privateKey),
  };
}

export function hederaClient(): Client {
  const { accountId, operatorKey } = requireEnv();
  return Client.forTestnet().setOperator(accountId, operatorKey);
}

export function ethersProvider(): JsonRpcProvider {
  return new JsonRpcProvider(TESTNET.rpcUrl, TESTNET.chainId, { batchMaxCount: 1 });
}

export function ethersSigner(): Wallet {
  const { operatorKey } = requireEnv();
  return new Wallet(operatorKey.toStringRaw(), ethersProvider());
}

export function hashscanTx(txHash: string): string {
  return `${TESTNET.hashscan}/transaction/${txHash}`;
}

export function hashscanContract(evmAddress: string): string {
  return `${TESTNET.hashscan}/contract/${evmAddress}`;
}
