import * as dotenv from "dotenv";
import * as path from "path";
import { AccountId, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { TESTNET } from "./config";

// Scripts run from packages/hardhat (workspace execution); the repo-root .env is two levels up.
dotenv.config({ path: path.join(__dirname, "../../../../.env") });

/** Parses an ECDSA hex key, DER-encoded hex key, or falls back to auto-detection. */
export function parsePrivateKey(key: string): PrivateKey {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    // 32-byte ECDSA hex key (what the Hedera Portal shows)
    return PrivateKey.fromStringECDSA(hex);
  }
  if (/^[0-9a-fA-F]{80,}$/.test(hex)) {
    // DER-encoded hex key
    return PrivateKey.fromStringDer(hex);
  }
  return PrivateKey.fromString(key);
}

export function requireEnv(): {
  accountId: AccountId;
  operatorKey: PrivateKey;
  accountIdString: string;
} {
  const accountIdString = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  if (!accountIdString || !privateKey) {
    throw new Error(
      "Missing HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY. Copy .env.example to .env in the repo root and fill it in.",
    );
  }
  return {
    accountIdString,
    accountId: AccountId.fromString(accountIdString),
    operatorKey: parsePrivateKey(privateKey),
  };
}

export function hederaClient() {
  const { accountId, operatorKey } = requireEnv();
  const client = Client.forTestnet()
    .setOperator(accountId, operatorKey)
    .setDefaultMaxTransactionFee(new Hbar(20))
    .setDefaultMaxQueryPayment(new Hbar(1));
  return client as Client;
}

export function ethersProvider(): JsonRpcProvider {
  return new JsonRpcProvider(process.env.HEDERA_RPC_URL || TESTNET.rpcUrl, TESTNET.chainId, {
    batchMaxCount: 1,
  });
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
