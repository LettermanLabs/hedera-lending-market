import test from "node:test";
import assert from "node:assert/strict";
import { withAuditRoute } from "./audit-route";
import { createAuditEvent, type AuditInput } from "./audit-event";
import type { AuditWriter } from "./audit-client";

function writer(record: AuditWriter["record"]): AuditWriter {
  return { record, flush: async () => ({ pending: 0, delivered: 0 }) };
}

test("request auditing uses server correlation and excludes headers, query parameters and bodies", async () => {
  const records: AuditInput[] = [];
  const route = withAuditRoute(
    "/api/activity",
    "POST",
    async () => Response.json({ ok: false }, { status: 422 }),
    () =>
      writer(async (input) => {
        createAuditEvent(input);
        records.push(input);
      }),
  );
  const response = await route(
    new Request("http://localhost/api/activity?secret=private-query", {
      method: "POST",
      headers: {
        Authorization: "Bearer private-token",
        "X-Request-Id": "caller-controlled",
      },
      body: JSON.stringify({ private_key: "private-body" }),
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(records.length, 2);
  assert.equal(records[0].request_id, records[1].request_id);
  assert.equal(records[0].request_id, response.headers.get("X-Request-Id"));
  assert.notEqual(records[0].request_id, "caller-controlled");
  assert.equal(records[1].outcome, "rejected");
  assert.equal(JSON.stringify(records).includes("private-"), false);
});

test("a failed initial audit write prevents the protected operation", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const route = withAuditRoute(
    "/api/activity",
    "POST",
    () => {
      calls++;
      return Response.json({ ok: true });
    },
    () =>
      writer(async () => {
        throw new Error("secret/path/failure");
      }),
  );
  const response = await route(
    new Request("http://localhost/api/activity", { method: "POST" }),
  );
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal((await response.text()).includes("secret"), false);
});

test("a failed outcome write does not turn a confirmed action into a retry", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });
  let writes = 0;
  const route = withAuditRoute(
    "/api/activity",
    "POST",
    () => Response.json({ ok: true, sequence: "7" }),
    () =>
      writer(async () => {
        if (++writes === 2) throw new Error("private-error");
      }),
  );
  const response = await route(
    new Request("http://localhost/api/activity", { method: "POST" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sequence: "7" });
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /audit.outcome_write_failed/);
  assert.equal(JSON.stringify(errors).includes("private-error"), false);
});

test("unexpected handler errors are reported without retaining their contents", async () => {
  const records: AuditInput[] = [];
  const route = withAuditRoute(
    "/api/price-update",
    "GET",
    () => {
      throw new Error("secret upstream URL");
    },
    () =>
      writer(async (input) => {
        records.push(input);
      }),
  );
  const response = await route(
    new Request("http://localhost/api/price-update"),
  );
  assert.equal(response.status, 502);
  assert.equal(records[1].outcome, "failed");
  assert.equal(records[1].status, 502);
  assert.equal((await response.text()).includes("secret"), false);
});
