import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapAmounts, tinycentsToRpcValue } from "./amounts";
import { waitForIndexedContract } from "./readiness";
import { beginStep, completeStep, deploymentPublicEnv, mergeEnv, type DeploymentRecord } from "./record";

test("100 HBAR at $0.10 seeds 10 USDX, with separate calldata and RPC units", () => {
  assert.deepEqual(bootstrapAmounts(100n * 10n ** 18n, "10000000", -8), {
    value18: 100n * 10n ** 18n,
    hbar8: 100n * 10n ** 8n,
    usdx6: 10n * 10n ** 6n,
  });
  assert.equal(tinycentsToRpcValue(10n ** 10n, "10000000", -8), 10n * 10n ** 18n);
  assert.equal(tinycentsToRpcValue(1n, "30000000", -8) % 10n ** 10n, 0n);
});

test("bootstrap refuses invalid prices and fractional tinybars", () => {
  for (const price of ["0", "-1", "NaN"]) assert.throws(() => bootstrapAmounts(10n ** 18n, price, -8));
  assert.throws(() => bootstrapAmounts(1n, "10000000", -8));
});

test("deployment env writes preserve custom endpoints, wallet IDs and server secrets", () => {
  const before =
    "# custom\nNEXT_PUBLIC_RPC_URL=https://example.test\nNEXT_PUBLIC_LENDING_POOL=old\nHEDERA_PRIVATE_KEY=example\nNEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=custom\n";
  const merged = mergeEnv(
    before,
    { NEXT_PUBLIC_LENDING_POOL: "new" },
    { NEXT_PUBLIC_RPC_URL: "default", NEXT_PUBLIC_MIRROR_NODE: "mirror" },
  );
  assert.match(merged, /NEXT_PUBLIC_LENDING_POOL=new/);
  assert.match(merged, /NEXT_PUBLIC_RPC_URL=https:\/\/example.test/);
  assert.match(merged, /HEDERA_PRIVATE_KEY=example/);
  assert.match(merged, /NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=custom/);
  assert.match(merged, /NEXT_PUBLIC_MIRROR_NODE=mirror/);
  assert.equal(
    mergeEnv(
      merged,
      { NEXT_PUBLIC_LENDING_POOL: "new" },
      { NEXT_PUBLIC_RPC_URL: "default", NEXT_PUBLIC_MIRROR_NODE: "mirror" },
    ),
    merged,
  );
});

test("deployment journal skips completed funding and blocks uncertain repeats", () => {
  const record = { network: "hedera-testnet", steps: {} } as DeploymentRecord;
  const writes: string[] = [];
  const persist = (value: DeploymentRecord) => {
    writes.push(JSON.stringify(value.steps));
  };
  assert.equal(beginStep(record, "seedLiquidity", persist), true);
  assert.throws(() => beginStep(record, "seedLiquidity", persist), /unresolved submission/);
  completeStep(record, "seedLiquidity", persist);
  assert.equal(beginStep(record, "seedLiquidity", persist), false);
  assert.equal(writes.length, 2);
});

test("an unseeded pair clears the frontend route even when a previous env enabled it", () => {
  const record = { ammPair: "0x123", steps: { ammSeed: { status: "pending" } } } as unknown as DeploymentRecord;
  const values = deploymentPublicEnv(record);
  assert.equal(values.NEXT_PUBLIC_AMM_PAIR, "");
  assert.match(
    mergeEnv("NEXT_PUBLIC_AMM_PAIR=stale\n", { NEXT_PUBLIC_AMM_PAIR: values.NEXT_PUBLIC_AMM_PAIR }),
    /^NEXT_PUBLIC_AMM_PAIR=\n$/,
  );
  record.steps!.ammSeed.status = "complete";
  assert.equal(deploymentPublicEnv(record).NEXT_PUBLIC_AMM_PAIR, "0x123");
});

test("new HAPI deployment waits for relay code and decodable contract reads", async () => {
  let codeReads = 0;
  let adminReads = 0;
  const provider = {
    async getCode() {
      return ++codeReads === 1 ? "0x" : "0x6000";
    },
  };
  const admin = await waitForIndexedContract(
    provider,
    "0xpool",
    async () => {
      if (++adminReads === 1) throw new Error("BAD_DATA 0x");
      return "0xoperator";
    },
    1000,
    1,
  );
  assert.equal(admin, "0xoperator");
  assert.equal(codeReads, 3);
  assert.equal(adminReads, 2);
});

test("relay readiness has a bounded wait even when an RPC call never settles", async () => {
  const provider = { getCode: () => new Promise<string>(() => {}) };
  await assert.rejects(
    waitForIndexedContract(provider, "0xpool", async () => "unused", 10, 1),
    /Retry deploy with the saved deployment record/,
  );
});
