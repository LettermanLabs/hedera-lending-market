import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  createAuditEvent,
  formatAuditEvent,
  parseAuditEvent,
} from "./audit-event";

const event = () =>
  createAuditEvent({
    request_id: randomUUID(),
    route: "/api/activity",
    method: "POST",
    actor: "anonymous",
    action: "request.completed",
    outcome: "rejected",
    status: 403,
  });

test("audit records reject extra fields and untrusted identity or text", () => {
  for (const extra of [
    { authorization: "Bearer private-token" },
    { body: { secret: "private-key" } },
    { message: "operator said success" },
    { ip: "192.0.2.1" },
    { actor: "administrator" },
    { route: "/api/activity?token=private-token" },
    { request_id: "forged\nrecord" },
    { status: 200 },
  ])
    assert.throws(() => parseAuditEvent({ ...event(), ...extra }));
  assert.throws(() => parseAuditEvent(null));
  assert.throws(() => parseAuditEvent([]));
  assert.equal(formatAuditEvent(event()), "POST /api/activity returned 403.");
});

test("HCS outcomes require receipt references and do not identify the HTTP requester as a wallet", () => {
  const input = {
    request_id: randomUUID(),
    route: "/api/activity",
    method: "POST",
    actor: "hedera-api",
    action: "hcs.submission.completed",
    outcome: "succeeded",
    context: {
      tx_hash: `0x${"a".repeat(64)}`,
      pool: `0x${"1".repeat(40)}`,
      account: `0x${"2".repeat(40)}`,
      topic_id: "0.0.123",
      sequence: "7",
    },
  } as const;
  const value = createAuditEvent(input);
  assert.equal(
    formatAuditEvent(value),
    "HCS submission confirmed at sequence 7.",
  );
  assert.throws(() => parseAuditEvent({ ...value, actor: "anonymous" }));
  assert.throws(() =>
    parseAuditEvent({
      ...value,
      context: { ...value.context, private_key: "secret" },
    }),
  );
  assert.throws(() => parseAuditEvent({ ...value, outcome: "unknown" }));
  assert.throws(() =>
    parseAuditEvent({
      ...value,
      context: { ...value.context, sequence: undefined },
    }),
  );
});

test("canonical serialization is independent of property order and does not retain mutable references", () => {
  assert.equal(
    canonicalJson({ b: [2, 1], a: { z: 1, c: 3 } }),
    canonicalJson({ a: { c: 3, z: 1 }, b: [2, 1] }),
  );
  const original = event();
  const parsed = parseAuditEvent(original);
  original.status = 500;
  assert.equal(parsed.status, 403);
});
