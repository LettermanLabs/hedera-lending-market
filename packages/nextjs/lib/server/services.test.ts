import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, toEventSelector } from "viem";
import { ActivityStore } from "./activity-store";
import { createActivityHandler } from "./activity-handler";
import { verifyActivity } from "./verified-activity";
import {
  createPriceService,
  HBAR_USD_FEED,
  validatePriceUpdate,
} from "./hermes";

const now = 1_790_051_300_000;
const hash = `0x${"a".repeat(64)}`;
const otherHash = `0x${"b".repeat(64)}`;
const pool = `0x${"1".repeat(40)}`;
const account = `0x${"2".repeat(40)}` as const;
const receipt = () => ({
  result: "SUCCESS",
  hash,
  to: pool,
  timestamp: "1790051297.525776104",
  logs: [
    {
      address: pool,
      index: 0,
      topics: [
        toEventSelector("Borrowed(address,uint256)"),
        `0x${"0".repeat(24)}${account.slice(2)}`,
      ],
      data: encodeAbiParameters([{ type: "uint256" }], [10_000_000n]),
    },
  ],
});
const update = () => ({
  binary: { encoding: "hex", data: ["aabbcc"] },
  parsed: [
    {
      id: HBAR_USD_FEED.slice(2),
      price: {
        price: "10000000",
        conf: "100",
        expo: -8,
        publish_time: now / 1000,
      },
    },
  ],
});

test("activity accepts pool event fields and rejects wrong pool, reverted, old, and malformed events", () => {
  const verified = verifyActivity(receipt(), hash, pool, now);
  assert.equal(verified.account, account);
  assert.equal(verified.type, "Borrowed");
  assert.equal(verified.amount, "10000000");
  assert.throws(() =>
    verifyActivity(
      { ...receipt(), result: "CONTRACT_REVERT_EXECUTED" },
      hash,
      pool,
      now,
    ),
  );
  assert.throws(() =>
    verifyActivity({ ...receipt(), to: account }, hash, pool, now),
  );
  assert.throws(() => verifyActivity(receipt(), otherHash, pool, now));
  assert.throws(() => verifyActivity(receipt(), hash, pool, now + 86401_000));
  assert.throws(() =>
    verifyActivity({ ...receipt(), logs: [] }, hash, pool, now),
  );
});

test("persistent reservations are atomic, survive restart, and cap hourly paid submissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcs-journal-"));
  try {
    const a = new ActivityStore(dir, "testnet:pool:topic", 1);
    const b = new ActivityStore(dir, "testnet:pool:topic", 1);
    const results = await Promise.all([
      a.reserve(hash, now),
      b.reserve(hash, now),
    ]);
    assert.equal(
      results.filter((result) => result.state === "reserved").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.state === "pending").length,
      1,
    );
    await a.save(hash, { state: "submitted", sequence: "42" });
    assert.deepEqual(await b.reserve(hash, now), {
      state: "submitted",
      sequence: "42",
    });
    assert.deepEqual(await b.reserve(otherHash, now), { state: "limited" });
    assert.deepEqual(await b.reserve(otherHash, now + 3600_000), {
      state: "reserved",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HCS verifies receipts, refuses forged body fields, and never repeats a paid submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcs-handler-"));
  let sends = 0;
  const messages: unknown[] = [];
  const handler = createActivityHandler({
    pool,
    topicId: "0.0.123",
    mirrorNode: "https://mirror.example",
    submitKey: "1234",
    now: () => now,
    store: new ActivityStore(dir, "scope"),
    fetcher: async (input) =>
      Response.json(
        String(input).includes("/topics/")
          ? { submit_key: { key: "1234" } }
          : receipt(),
      ),
    prepare(message) {
      messages.push(message);
      return {
        id: "0.0.1@1.2",
        send: async () => {
          sends++;
          return "7";
        },
      };
    },
  });
  const request = (body: unknown) =>
    new Request("http://localhost/api/activity", {
      method: "POST",
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await handler(request({ txHash: hash, account: "fake" }))).status,
      400,
    );
    assert.equal(sends, 0);
    assert.equal((await handler(request({ txHash: hash }))).status, 200);
    assert.equal((await handler(request({ txHash: hash }))).status, 200);
    assert.equal(sends, 1);
    assert.equal((messages[0] as { account: string }).account, account);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HCS rejects open topics and retains ambiguous submission outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcs-failure-"));
  let restricted = false;
  let sends = 0;
  const handler = createActivityHandler({
    pool,
    topicId: "0.0.123",
    mirrorNode: "https://mirror.example",
    submitKey: "1234",
    now: () => now,
    store: new ActivityStore(dir, "scope"),
    fetcher: async (input) =>
      Response.json(
        String(input).includes("/topics/")
          ? { submit_key: restricted ? { key: "1234" } : null }
          : receipt(),
      ),
    prepare() {
      return {
        id: "0.0.1@1.2",
        send: async () => {
          sends++;
          throw new Error("uncertain transport outcome");
        },
      };
    },
  });
  const request = () =>
    new Request("http://localhost/api/activity", {
      method: "POST",
      body: JSON.stringify({ txHash: hash }),
    });
  try {
    assert.equal((await handler(request())).status, 503);
    assert.equal(sends, 0);
    restricted = true;
    assert.equal((await handler(request())).status, 502);
    assert.equal((await handler(request())).status, 503);
    assert.equal(sends, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Hermes sends auth only upstream, caches one feed, and rejects arbitrary feed proxying", async () => {
  let calls = 0;
  const service = createPriceService({
    baseUrl: "https://hermes.example",
    feedId: HBAR_USD_FEED,
    apiKey: "test-key",
    now: () => now,
    fetcher: async (input, init) => {
      calls++;
      assert.equal(
        new URL(String(input)).searchParams.get("ids[]"),
        HBAR_USD_FEED,
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-key",
      );
      return Response.json(update());
    },
  });
  const values = await Promise.all([
    service(HBAR_USD_FEED),
    service(HBAR_USD_FEED),
  ]);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(values).includes("test-key"), false);
  const upstream = update();
  const withMetadata = {
    ...upstream,
    parsed: [{ ...upstream.parsed[0], apiKey: "private-debug-metadata" }],
  };
  assert.equal(
    JSON.stringify(
      validatePriceUpdate(withMetadata, HBAR_USD_FEED, now),
    ).includes("private-debug-metadata"),
    false,
  );
  await assert.rejects(service(otherHash), /Only the configured/);
  assert.throws(
    () => validatePriceUpdate(update(), HBAR_USD_FEED, now + 120_000),
    /stale/,
  );
  const denied = createPriceService({
    baseUrl: "https://hermes.example",
    feedId: HBAR_USD_FEED,
    fetcher: async () => new Response(null, { status: 401 }),
  });
  await assert.rejects(denied(HBAR_USD_FEED), /PYTH_API_KEY/);
});
