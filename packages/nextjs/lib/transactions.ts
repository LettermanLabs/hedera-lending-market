import type { Hash } from "viem";

interface ReceiptClient {
  waitForTransactionReceipt(args: {
    hash: Hash;
    timeout: number;
    onReplaced: (replacement: { reason: string }) => void;
  }): Promise<{ status: string; transactionHash: Hash }>;
}

/** A hash is only submission: dependent actions require a successful receipt. */
export async function confirmTransaction(
  client: ReceiptClient,
  hash: Hash,
): Promise<Hash> {
  let changed = false;
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
    onReplaced: (replacement) => {
      if (replacement.reason !== "repriced") changed = true;
    },
  });
  if (changed)
    throw new Error(
      "The transaction was cancelled or replaced. Check your wallet before retrying.",
    );
  if (receipt.status !== "success")
    throw new Error(
      "The transaction reverted. No market action was completed.",
    );
  return receipt.transactionHash;
}
