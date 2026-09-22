import assert from "node:assert/strict";
import test from "node:test";
import type { Hash } from "viem";
import { confirmTransaction } from "./transactions";

const hash = `0x${"1".repeat(64)}` as Hash;
const replacement = `0x${"2".repeat(64)}` as Hash;

test("approval confirmation does not release the next action before the receipt", async () => {
  let resolve!: (receipt: { status: string; transactionHash: Hash }) => void;
  let continued = false;
  const client = {
    waitForTransactionReceipt: () =>
      new Promise<{ status: string; transactionHash: Hash }>((done) => {
        resolve = done;
      }),
  };
  const flow = confirmTransaction(client, hash).then(() => {
    continued = true;
  });
  await Promise.resolve();
  assert.equal(continued, false);
  resolve({ status: "success", transactionHash: hash });
  await flow;
  assert.equal(continued, true);
});

test("reverted receipts are never reported as successful actions", async () => {
  await assert.rejects(
    confirmTransaction(
      {
        waitForTransactionReceipt: async () => ({
          status: "reverted",
          transactionHash: hash,
        }),
      },
      hash,
    ),
    /reverted/,
  );
});

test("cancelled replacements reject but gas-only repricing returns confirmed hash", async () => {
  for (const reason of ["cancelled", "replaced", "repriced"]) {
    const client = {
      waitForTransactionReceipt: async ({
        onReplaced,
      }: {
        onReplaced: (event: { reason: string }) => void;
      }) => {
        onReplaced({ reason });
        return { status: "success", transactionHash: replacement };
      },
    };
    if (reason === "repriced")
      assert.equal(await confirmTransaction(client, hash), replacement);
    else
      await assert.rejects(
        confirmTransaction(client, hash),
        /cancelled or replaced/,
      );
  }
});
