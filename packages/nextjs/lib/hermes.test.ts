import assert from "node:assert/strict";
import test from "node:test";
import { fetchPriceSnapshot } from "./hermes";

const feed = `0x${"a".repeat(64)}`;
function response(publishTime: number) {
  return {
    binary: { data: ["aabb"] },
    parsed: [
      {
        id: feed.slice(2),
        price: { price: "10000000", expo: -8, publish_time: publishTime },
      },
    ],
  };
}

test("price requests use the server proxy and validate the requested feed", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.startsWith("/api/price-update?feedId="));
    return Response.json(response(Math.floor(Date.now() / 1000)));
  });
  const snapshot = await fetchPriceSnapshot(feed);
  assert.equal(snapshot.price18, 100_000_000_000_000_000n);
  assert.deepEqual(snapshot.updateData, ["0xaabb"]);
  await assert.rejects(
    fetchPriceSnapshot(`0x${"b".repeat(64)}`),
    /requested HBAR feed/,
  );
});

test("stale or unavailable oracle data does not proceed to wallet submission", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(response(Math.floor(Date.now() / 1000) - 121)),
  );
  await assert.rejects(fetchPriceSnapshot(feed), /stale/);
});
