import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  chmod,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AuditConfigurationError,
  AuditUnavailableError,
  createAuditWriter,
  getAuditWriter,
  type AuditWriterConfig,
} from "./audit-client";
import type { AuditEvent, AuditInput } from "./audit-event";

function counts(summary: { pending: number; delivered: number }) {
  return { pending: summary.pending, delivered: summary.delivered };
}

const token = "delivery-test-token-32-characters-long";
const input = (): AuditInput => ({
  request_id: randomUUID(),
  action: "request.started",
  outcome: "started",
  actor: "anonymous",
  route: "/api/price-update",
  method: "GET",
});

async function fixture(t: TestContext, extra: Partial<AuditWriterConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hedera-audit-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const config: AuditWriterConfig = {
    mode: "required",
    collectorUrl: "https://audit.example.test/v1/events",
    collectorToken: token,
    outboxDir: join(root, "outbox"),
    logger: (line) => lines.push(line),
    fetch: async () => {
      throw new Error(`Connection refused with ${token}`);
    },
    ...extra,
  };
  return { root, config, lines, writer: createAuditWriter(config) };
}

const success: typeof fetch = async (_url, init) => {
  const event = JSON.parse(String(init?.body)) as AuditEvent;
  return Response.json({ ok: true, event_id: event.event_id });
};

async function records(directory: string) {
  return (await readdir(directory)).filter((name) => name.endsWith(".json"));
}

test("an outage retains the exact event for delivery after a process restart", async (t) => {
  const { config, writer, lines } = await fixture(t);
  const eventInput = input();
  await writer.record(eventInput);
  const names = await records(config.outboxDir!);
  assert.equal(names.length, 1);
  const stored = JSON.parse(
    await readFile(join(config.outboxDir!, names[0]), "utf8"),
  );
  assert.equal(stored.request_id, eventInput.request_id);
  assert.equal(`${stored.event_id}.json`, names[0]);
  assert.equal((await stat(config.outboxDir!)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(config.outboxDir!, names[0]))).mode & 0o777,
    0o600,
  );
  assert.equal(lines.length, 1);
  assert.ok(!lines.join("").includes(token));
  assert.ok(!lines.join("").includes("audit.example.test"));
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), [
    "component",
    "delivery_failures",
    "request_id",
  ]);
  let received: unknown;
  const restarted = createAuditWriter({
    ...config,
    fetch: async (url, init) => {
      assert.equal(url, config.collectorUrl);
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${token}`,
      );
      received = JSON.parse(String(init?.body));
      return success(url, init);
    },
  });
  assert.deepEqual(counts(await restarted.flush()), {
    pending: 0,
    delivered: 1,
  });
  assert.deepEqual(received, stored);
  assert.deepEqual(await records(config.outboxDir!), []);
});

test("flush respects its batch limit and a request does not replay the backlog", async (t) => {
  const { writer, config } = await fixture(t, { batchSize: 2 });
  for (let i = 0; i < 4; i++) await writer.record(input());
  let sent = 0;
  const recovered = createAuditWriter({
    ...config,
    fetch: async (url, init) => {
      sent++;
      return success(url, init);
    },
  });
  await recovered.record(input());
  assert.equal(sent, 1);
  assert.equal((await records(config.outboxDir!)).length, 4);
  assert.deepEqual(counts(await recovered.flush()), {
    pending: 2,
    delivered: 2,
  });
  assert.deepEqual(counts(await recovered.flush()), {
    pending: 0,
    delivered: 2,
  });
});

test("wrong IDs, oversized responses, redirects, and error bodies never acknowledge a record", async (t) => {
  const replies = [
    () => Response.json({ ok: true, event_id: randomUUID() }),
    () => Response.json({ ok: "true" }),
    () => new Response("x".repeat(1_025)),
    () => new Response(token, { status: 500 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://wrong.test/" },
      }),
    () => new Response("invalid json"),
  ];
  for (const reply of replies) {
    const { writer, config, lines } = await fixture(t, {
      fetch: async () => reply(),
    });
    await writer.record(input());
    assert.equal((await records(config.outboxDir!)).length, 1);
    assert.ok(!lines.join("").includes(token));
  }
});

test("the delivery timeout covers both headers and a stalled acknowledgement body", async (t) => {
  for (const request of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const { writer, config } = await fixture(t, {
      fetch: request,
      timeoutMs: 20,
    });
    const start = performance.now();
    await writer.record(input());
    assert.ok(performance.now() - start < 500);
    assert.equal((await records(config.outboxDir!)).length, 1);
  }
});

test("capacity is enforced across concurrent writers in the same process", async (t) => {
  const { writer, config } = await fixture(t, { maxPending: 8 });
  const second = createAuditWriter(config);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? writer : second).record(input()),
    ),
  );
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    2,
  );
  assert.equal((await records(config.outboxDir!)).length, 2);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected")
      assert.ok(outcome.reason instanceof AuditUnavailableError);
  }
});

test("required mode rejects malformed records before any delivery or accepted file", async (t) => {
  let calls = 0;
  const { writer, root } = await fixture(t, {
    fetch: async (url, init) => {
      calls++;
      return success(url, init);
    },
  });
  await assert.rejects(
    writer.record({
      ...input(),
      authorization: "Bearer sample-token",
    } as AuditInput),
    AuditUnavailableError,
  );
  await assert.rejects(
    writer.record({ ...input(), request_id: "private credential" }),
    AuditUnavailableError,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test("unsafe permissions and corrupted records fail closed without leaking their contents", async (t) => {
  const { writer, config } = await fixture(t);
  await writer.record(input());
  await chmod(config.outboxDir!, 0o755);
  await assert.rejects(writer.record(input()), {
    name: "AuditUnavailableError",
    message: "Audit logging is unavailable",
  });
  await chmod(config.outboxDir!, 0o700);
  const file = join(config.outboxDir!, (await records(config.outboxDir!))[0]);
  await writeFile(file, `private text ${token}`);
  await assert.rejects(writer.flush(), {
    name: "AuditUnavailableError",
    message: "Audit logging is unavailable",
  });
  assert.equal((await records(config.outboxDir!)).length, 1);
});

test("event-file symlinks and mismatched filenames are not delivered", async (t) => {
  for (const useSymlink of [true, false]) {
    const { writer, config, root } = await fixture(t);
    await writer.record(input());
    const file = join(config.outboxDir!, (await records(config.outboxDir!))[0]);
    const text = await readFile(file, "utf8");
    if (useSymlink) {
      const target = join(root, "elsewhere.json");
      await writeFile(target, text, { mode: 0o600 });
      await rm(file);
      await symlink(target, file);
    } else {
      const altered = JSON.parse(text);
      altered.event_id = randomUUID();
      await writeFile(file, JSON.stringify(altered));
    }
    await assert.rejects(
      createAuditWriter({ ...config, fetch: success }).flush(),
      AuditUnavailableError,
    );
  }
});

test("configuration rejects unsafe collector endpoints", async (t) => {
  const { config } = await fixture(t);
  for (const collectorUrl of [
    "http://audit.example.test/v1/events",
    "https://user:password@audit.example.test/v1/events",
    "https://audit.example.test/v1/events?token=secret",
    "https://audit.example.test/v1/events#fragment",
    "https://audit.example.test/v1/events?",
    "https://audit.example.test/v1/events#",
    "https://audit.example.test/",
    "ftp://localhost/v1/events",
    "http://localhost.evil.test/v1/events",
    "invalid",
  ])
    assert.throws(
      () => createAuditWriter({ ...config, collectorUrl }),
      AuditConfigurationError,
    );
  for (const collectorUrl of [
    "http://127.0.0.1:8080/v1/events",
    "http://localhost/v1/events",
    "http://[::1]/v1/events",
  ])
    assert.doesNotThrow(() => createAuditWriter({ ...config, collectorUrl }));
});

test("outboxes must be absolute and separate from code, activity data, and collector data", async (t) => {
  const { config, root } = await fixture(t);
  for (const extra of [
    { outboxDir: "./relative" },
    { outboxDir: process.cwd() },
    { outboxDir: join(process.cwd(), "audit") },
    { activityStoreDir: root },
    { activityStoreDir: config.outboxDir },
    { auditLogDir: config.outboxDir },
    { auditLogDir: join(config.outboxDir!, "collector") },
  ])
    assert.throws(
      () => createAuditWriter({ ...config, ...extra }),
      AuditConfigurationError,
    );
  await symlink(process.cwd(), join(root, "code-link"));
  assert.throws(
    () =>
      createAuditWriter({
        ...config,
        outboxDir: join(root, "code-link", "outbox"),
      }),
    AuditConfigurationError,
  );
});

test("invalid mode or required configuration never silently disables audit logging", async (t) => {
  const { config } = await fixture(t);
  for (const extra of [
    { mode: "Required" },
    { collectorToken: "short" },
    { collectorToken: `${token}\n` },
    { outboxDir: undefined },
    { collectorUrl: undefined },
    { maxPending: 0 },
    { batchSize: 101 },
    { timeoutMs: 2_001 },
  ])
    assert.throws(
      () => createAuditWriter({ ...config, ...extra }),
      AuditConfigurationError,
    );
  await createAuditWriter().record(input());
  assert.deepEqual(await createAuditWriter({ mode: "off" }).flush(), {
    pending: 0,
    delivered: 0,
  });
});

test("environment configuration does not keep an obsolete off-mode writer", () => {
  const previous = process.env.AUDIT_MODE;
  try {
    process.env.AUDIT_MODE = "off";
    assert.doesNotThrow(() => getAuditWriter());
    process.env.AUDIT_MODE = "invalid";
    assert.throws(() => getAuditWriter(), AuditConfigurationError);
  } finally {
    if (previous === undefined) delete process.env.AUDIT_MODE;
    else process.env.AUDIT_MODE = previous;
  }
});

test("replay uses event chronology and reports oldest pending age separately from unfinished writes", async (t) => {
  const { writer, config } = await fixture(t, { batchSize: 1 });
  for (let index = 0; index < 3; index++) await writer.record(input());
  const names = (await records(config.outboxDir!)).sort();
  const now = Date.now();
  const times = [30, 60, 120].map((age) =>
    new Date(now - age * 1_000).toISOString(),
  );
  for (const [index, name] of names.entries()) {
    const path = join(config.outboxDir!, name);
    const event = JSON.parse(await readFile(path, "utf8"));
    event.occurred_at = times[index];
    await writeFile(path, JSON.stringify(event));
  }
  await writeFile(
    join(config.outboxDir!, `.pending-${randomUUID()}`),
    "unfinished",
    { mode: 0o600 },
  );
  const unavailable = await writer.flush();
  assert.equal(unavailable.pending, 4);
  assert.equal(unavailable.delivered, 0);
  assert.equal(unavailable.temporary_files, 1);
  assert.equal(unavailable.oldest_pending_at, times[2]);
  assert.ok(
    unavailable.oldest_pending_age_seconds! >= 120 &&
      unavailable.oldest_pending_age_seconds! <= 121,
  );

  const received: string[] = [];
  const recovered = createAuditWriter({
    ...config,
    fetch: async (url, init) => {
      received.push(JSON.parse(String(init?.body)).occurred_at);
      return success(url, init);
    },
  });
  const first = await recovered.flush();
  assert.equal(first.pending, 3);
  assert.equal(first.delivered, 1);
  assert.equal(first.oldest_pending_at, times[1]);
  await recovered.flush();
  const last = await recovered.flush();
  assert.deepEqual(received, [times[2], times[1], times[0]]);
  assert.deepEqual(last, {
    pending: 1,
    delivered: 1,
    temporary_files: 1,
    oldest_pending_at: null,
    oldest_pending_age_seconds: null,
  });
});

test("admitted requests keep room for both HCS records and completion during an outage", async (t) => {
  const { writer, config } = await fixture(t, { maxPending: 8 });
  const starts = [input(), input()].map(
    (event) =>
      ({ ...event, route: "/api/activity", method: "POST" }) as AuditInput,
  );
  const second = createAuditWriter(config);
  await Promise.all(
    starts.map((event, index) => (index ? second : writer).record(event)),
  );
  await assert.rejects(writer.record(input()), AuditUnavailableError);
  const context = {
    tx_hash: `0x${"1".repeat(64)}`,
    pool: `0x${"2".repeat(40)}`,
    account: `0x${"3".repeat(40)}`,
    topic_id: "0.0.123",
  };
  await Promise.all(
    starts.map(async (start) => {
      const hcs = { ...start, actor: "hedera-api" as const, context };
      await writer.record({
        ...hcs,
        action: "hcs.submission.started",
        outcome: "started",
      });
      await writer.record({
        ...hcs,
        action: "hcs.submission.completed",
        outcome: "succeeded",
        context: { ...context, sequence: "1" },
      });
      await writer.record({
        ...start,
        action: "request.completed",
        outcome: "succeeded",
        status: 200,
      });
    }),
  );
  assert.equal((await records(config.outboxDir!)).length, 8);
  const events = await Promise.all(
    (await records(config.outboxDir!)).map(async (name) =>
      JSON.parse(await readFile(join(config.outboxDir!, name), "utf8")),
    ),
  );
  for (const start of starts) {
    assert.deepEqual(
      events
        .filter((event) => event.request_id === start.request_id)
        .map((event) => event.action)
        .sort(),
      [
        "hcs.submission.completed",
        "hcs.submission.started",
        "request.completed",
        "request.started",
      ],
    );
  }
  await assert.rejects(writer.record(input()), AuditUnavailableError);
  const recovered = createAuditWriter({ ...config, fetch: success });
  assert.equal((await recovered.flush()).pending, 0);
  await recovered.record(input());
});

test("short requests release unused reservations and a queue smaller than four rejects admission", async (t) => {
  const { writer, config } = await fixture(t, { maxPending: 6 });
  const start = input();
  await writer.record(start);
  await assert.rejects(writer.record(input()), AuditUnavailableError);
  await writer.record({
    ...start,
    action: "request.completed",
    outcome: "succeeded",
    status: 200,
  });
  await writer.record(input());
  assert.equal((await records(config.outboxDir!)).length, 3);
  const tooSmall = await fixture(t, { maxPending: 3 });
  await assert.rejects(tooSmall.writer.record(input()), AuditUnavailableError);
  assert.deepEqual(await records(tooSmall.config.outboxDir!), []);
});
