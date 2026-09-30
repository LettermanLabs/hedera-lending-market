import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createAuditWriter } from "../../packages/nextjs/lib/server/audit-client";
import { withAuditRoute } from "../../packages/nextjs/lib/server/audit-route";
import { createCollector } from "./server";
import {
  AuditJournal,
  JOURNAL_NAME,
  verifyJournal,
  type AuditRecord,
} from "./journal";
import { csvRecord } from "./export";

test("the app writes to a separate collector and receives durable acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "hedera-audit-integration-"));
  const signingKey = randomBytes(32).toString("hex");
  const token = randomBytes(32).toString("hex");
  const ledger = join(root, "collector");
  const outbox = join(root, "outbox");
  const journal = await AuditJournal.open({ directory: ledger, signingKey });
  const server = createCollector({ journal, token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const collectorUrl = `http://127.0.0.1:${address.port}/v1/events`;
  try {
    const writer = createAuditWriter({
      mode: "required",
      collectorUrl,
      collectorToken: token,
      outboxDir: outbox,
    });
    const route = withAuditRoute(
      "/api/activity",
      "GET",
      () => Response.json({ ok: true, configured: false }),
      () => writer,
    );
    const response = await route(
      new Request("http://localhost/api/activity?private=not-for-the-ledger", {
        headers: { Authorization: "Bearer confidential-client-token" },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await readdir(outbox), []);
    assert.equal(journal.checkpoint.sequence, 2);
    const records: AuditRecord[] = [];
    const verification = await verifyJournal(
      join(ledger, JOURNAL_NAME),
      signingKey,
      { onRecord: (record) => records.push(record) },
    );
    assert.equal(verification.records, 2);
    assert.deepEqual(
      records.map((record) => record.event.action),
      ["request.started", "request.completed"],
    );
    assert.equal(
      records[0].event.request_id,
      response.headers.get("X-Request-Id"),
    );
    assert.equal(records[1].event.request_id, records[0].event.request_id);
    assert.match(csvRecord(records[1]), /GET \/api\/activity returned 200/);
    for (const secret of [
      "confidential-client-token",
      "not-for-the-ledger",
      token,
      signingKey,
    ])
      assert.equal(JSON.stringify(records).includes(secret), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a lost collector response is replayed once without duplicating the retained event", async () => {
  const root = await mkdtemp(join(tmpdir(), "hedera-audit-replay-"));
  const signingKey = randomBytes(32).toString("hex");
  const token = randomBytes(32).toString("hex");
  const ledger = join(root, "collector");
  const outbox = join(root, "outbox");
  const journal = await AuditJournal.open({ directory: ledger, signingKey });
  const server = createCollector({ journal, token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    mode: "required",
    collectorUrl: `http://127.0.0.1:${address.port}/v1/events`,
    collectorToken: token,
    outboxDir: outbox,
    logger: () => {},
  };
  try {
    const writer = createAuditWriter({
      ...config,
      fetch: async (...args) => {
        const response = await fetch(...args);
        assert.equal(response.status, 201);
        await response.body?.cancel();
        throw new Error("Simulated lost acknowledgement");
      },
    });
    await writer.record({
      request_id: randomUUID(),
      route: "/api/price-update",
      method: "GET",
      actor: "anonymous",
      action: "request.completed",
      outcome: "rejected",
      status: 400,
    });
    assert.equal((await readdir(outbox)).length, 1);
    assert.equal(journal.checkpoint.sequence, 1);
    const retry = await createAuditWriter(config).flush();
    assert.equal(retry.delivered, 1);
    assert.equal(retry.pending, 0);
    assert.equal(journal.checkpoint.sequence, 1);
    assert.equal(
      (await verifyJournal(join(ledger, JOURNAL_NAME), signingKey)).records,
      1,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
