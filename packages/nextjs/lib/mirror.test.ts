import assert from "node:assert/strict";
import test from "node:test";
import { toEventSelector } from "viem";
import { fetchRecentBorrowers, parseTopicMessage } from "./mirror";

const pool = `0x${"a".repeat(40)}` as const;
const borrower1 = "1".repeat(40);
const borrower2 = "2".repeat(40);
const log = (address: string, event = "Borrowed(address,uint256)") => ({
  topics: [toEventSelector(event), `0x${"0".repeat(24)}${address}`],
});

test("borrower scanning follows pagination and retains older outstanding accounts", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(
      new URL(url).searchParams.has("topic0"),
      false,
      "unbounded topic filters are rejected by the Hedera mirror node",
    );
    requests += 1;
    return Response.json(
      requests === 1
        ? {
            logs: [
              log(borrower1),
              log("3".repeat(40), "CollateralDeposited(address,uint256)"),
            ],
            links: {
              next: `/api/v1/contracts/${pool}/results/logs?timestamp=lt:1`,
            },
          }
        : { logs: [log(borrower1), log(borrower2)], links: { next: null } },
    );
  });
  assert.deepEqual(
    await fetchRecentBorrowers("https://testnet.mirrornode.hedera.com", pool),
    [`0x${borrower1}`, `0x${borrower2}`],
  );
  assert.equal(requests, 2);
});

test("a pool with only deposits has no borrowers", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      logs: [
        log(borrower1, "CollateralDeposited(address,uint256)"),
        log(borrower2, "Supplied(address,uint256)"),
      ],
      links: { next: null },
    }),
  );
  assert.deepEqual(
    await fetchRecentBorrowers("https://testnet.mirrornode.hedera.com", pool),
    [],
  );
});

test("invalid mirror responses and off-origin pagination fail visibly", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      logs: [],
      links: { next: "https://untrusted.invalid/events" },
    }),
  );
  await assert.rejects(
    fetchRecentBorrowers("https://testnet.mirrornode.hedera.com", pool),
    /Unexpected/,
  );
});

test("untrusted topic messages cannot crash rendering or inject arbitrary fields", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64");
  assert.equal(
    parseTopicMessage(
      encode({ type: {}, account: [], txHash: "javascript:alert(1)" }),
      1,
      "100.123",
    )?.type,
    "unrecognized message",
  );
  assert.equal(
    parseTopicMessage(encode(null), 2, "100.123")?.account,
    undefined,
  );
  assert.equal(
    parseTopicMessage(
      encode({ type: "Borrowed", account: `0x${borrower1}` }),
      3,
      "100.123",
    )?.type,
    "Borrowed",
  );
  assert.equal(
    parseTopicMessage(encode({ type: "café" }), 4, "100.123")?.type,
    "café",
  );
  assert.equal(
    parseTopicMessage("not base64", 5, "100.123")?.type,
    "unrecognized message",
  );
});
