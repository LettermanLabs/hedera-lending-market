import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import {
  createAuditEvent,
  type AuditEvent,
} from "../../packages/nextjs/lib/server/audit-event";
import { createCollector } from "./server";
import { csvCell, csvHeader, csvRecord } from "./export";
import {
  AuditJournal,
  DuplicateEventError,
  EMPTY_HASH,
  JOURNAL_NAME,
  LOCK_NAME,
  verifyJournal,
} from "./journal";

const signingKey = "test-signing-key-" + "s".repeat(32);
const token = "test-writer-token-" + "t".repeat(32);
function event(): AuditEvent {
  return createAuditEvent({
    request_id: randomUUID(),
    action: "request.completed",
    actor: "anonymous",
    route: "/api/activity",
    method: "GET",
    outcome: "succeeded",
    status: 200,
  });
}

const cleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();
function cleanup(t: TestContext, callback: () => Promise<void>) {
  const callbacks = cleanups.get(t) ?? [];
  callbacks.push(callback);
  cleanups.set(t, callbacks);
}

async function temporary(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hedera-audit-test-"));
  t.after(async () => {
    for (const close of (cleanups.get(t) ?? []).splice(0).reverse())
      await close();
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t: TestContext) {
  const directory = await temporary(t);
  const journal = await AuditJournal.open({ directory, signingKey });
  const server = createCollector({ journal, token, requestTimeoutMs: 500 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  cleanup(t, async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await journal.close();
  });
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + "/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { directory, journal, server, url, send };
}

test("collector rejects missing, incorrect and ambiguous credentials without storing data", async (t) => {
  const { send, journal, url } = await fixture(t);
  for (const authorization of [
    "",
    "Bearer wrong",
    `bearer ${token}`,
    `Bearer ${token}x`,
  ]) {
    const response = await send(event(), { authorization });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
  const response = await fetch(url + "/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event()),
  });
  assert.equal(response.status, 401);
  assert.equal(journal.checkpoint.sequence, 0);
});

test("collector accepts only its write API and terse health response", async (t) => {
  const { journal, url } = await fixture(t);
  const health = await fetch(url + "/health");
  assert.deepEqual(await health.json(), { status: "ok" });
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await fetch(url + "/v1/events", { method })).status, 405);
  }
  for (const endpoint of [
    "/v1/events/1",
    "/journal.jsonl",
    "/health?details=true",
    "/v1/events?all=1",
  ]) {
    assert.equal((await fetch(url + endpoint)).status, 404);
  }
  assert.equal(journal.checkpoint.sequence, 0);
});

test("collector rejects unsupported fields, malformed JSON and content encodings", async (t) => {
  const { send, journal, url } = await fixture(t);
  for (const body of [
    { ...event(), debug_detail: "arbitrary request detail" },
    { ...event(), context: { secret: "private text" } },
    { ...event(), status: 500 },
    [],
    null,
  ]) {
    const response = await send(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_event" });
  }
  const malformed = await fetch(url + "/v1/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    (await send(event(), { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await send(event(), { "content-encoding": "gzip" })).status,
    415,
  );
  assert.equal(journal.checkpoint.sequence, 0);
});

test("collector enforces declared and streamed body limits", async (t) => {
  const { send, journal, url } = await fixture(t);
  assert.equal((await send({ private: "x".repeat(4096) })).status, 413);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      url + "/v1/events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.write("x".repeat(2048));
    req.end("x".repeat(2049));
  });
  assert.equal(status, 413);
  assert.equal(journal.checkpoint.sequence, 0);
});

test("collector times out an incomplete body without storing a record", async (t) => {
  const { journal, url } = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const req = request(
      url + "/v1/events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": "100",
        },
      },
      (res) => {
        assert.equal(res.statusCode, 408);
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNRESET" ? resolve() : reject(error),
    );
    req.write("{");
  });
  assert.equal(journal.checkpoint.sequence, 0);
});

test("acknowledged records survive restart and retries do not add records", async (t) => {
  const directory = await temporary(t);
  const input = event();
  let journal = await AuditJournal.open({ directory, signingKey });
  const first = await journal.append(input);
  assert.equal(first.duplicate, false);
  assert.equal(
    (await readFile(path.join(directory, JOURNAL_NAME), "utf8"))
      .split("\n")
      .filter(Boolean).length,
    1,
  );
  await journal.close();
  journal = await AuditJournal.open({ directory, signingKey });
  cleanup(t, () => journal.close());
  assert.deepEqual(await journal.append(input), {
    record: first.record,
    duplicate: true,
  });
  await assert.rejects(
    journal.append({ ...input, status: 201 }),
    DuplicateEventError,
  );
  assert.equal(journal.checkpoint.sequence, 1);
  assert.equal(
    (await verifyJournal(path.join(directory, JOURNAL_NAME), signingKey))
      .records,
    1,
  );
});

test("HTTP retries return the original receipt and conflicting event IDs return 409", async (t) => {
  const { send, journal } = await fixture(t);
  const input = event();
  const first = await send(input);
  assert.equal(first.status, 201);
  const receipt = (await first.json()) as { hash: string };
  const retry = await send(input);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    ok: true,
    event_id: input.event_id,
    accepted: true,
    duplicate: true,
    sequence: 1,
    hash: receipt.hash,
  });
  const conflict = await send({ ...input, status: 201 });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "event_conflict" });
  assert.equal(journal.checkpoint.sequence, 1);
});

test("HTTP success waits for fsync and a failed sync poisons the writer and health endpoint", async (t) => {
  const { journal, send, url } = await fixture(t);
  const file = (journal as unknown as { file: FileHandle }).file;
  const sync = file.sync.bind(file);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = t.mock.method(file, "sync", async () => {
    enter();
    await gate;
    await sync();
  });
  let responded = false;
  const pending = send(event()).then((response) => {
    responded = true;
    return response;
  });
  await entered;
  assert.equal(responded, false);
  assert.equal(journal.checkpoint.sequence, 0);
  release();
  assert.equal((await pending).status, 201);
  mock.mock.restore();
  t.mock.method(file, "sync", async () => {
    throw new Error("simulated disk failure with private details");
  });
  const failed = await send(event());
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "collector_unavailable" });
  const health = await fetch(url + "/health");
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { status: "unavailable" });
  assert.equal(journal.checkpoint.sequence, 1);
});

test("concurrent submissions preserve chain order and one copy of each event", async (t) => {
  const directory = await temporary(t);
  const journal = await AuditJournal.open({ directory, signingKey });
  cleanup(t, () => journal.close());
  const inputs = Array.from({ length: 30 }, event);
  const results = await Promise.all(
    inputs.flatMap((input) => [journal.append(input), journal.append(input)]),
  );
  assert.equal(results.filter((result) => result.duplicate).length, 30);
  assert.deepEqual(
    results
      .filter((result) => !result.duplicate)
      .map((result) => result.record.sequence),
    Array.from({ length: 30 }, (_, i) => i + 1),
  );
  assert.equal(
    (await verifyJournal(path.join(directory, JOURNAL_NAME), signingKey))
      .records,
    30,
  );
});

test("file edits, partial tails and the wrong signing key fail verification and startup", async (t) => {
  for (const kind of ["edit", "partial", "wrong_key"]) {
    const directory = await temporary(t);
    const filename = path.join(directory, JOURNAL_NAME);
    const journal = await AuditJournal.open({ directory, signingKey });
    await journal.append(event());
    await journal.close();
    if (kind === "edit") {
      const raw = await readFile(filename, "utf8");
      await writeFile(filename, raw.replace('"status":200', '"status":201'));
    } else if (kind === "partial") await appendFile(filename, '{"version":1');
    const key = kind === "wrong_key" ? "different-key-".repeat(4) : signingKey;
    await assert.rejects(verifyJournal(filename, key), /verification failed/);
    await assert.rejects(
      AuditJournal.open({ directory, signingKey: key }),
      /verification failed/,
    );
    await assert.rejects(stat(path.join(directory, LOCK_NAME)), {
      code: "ENOENT",
    });
  }
});

test("independent checkpoints detect a valid whole-record tail removed from the journal", async (t) => {
  const directory = await temporary(t);
  const filename = path.join(directory, JOURNAL_NAME);
  const journal = await AuditJournal.open({ directory, signingKey });
  await journal.append(event());
  const firstHead = journal.checkpoint;
  const firstSize = (await stat(filename)).size;
  await journal.append(event());
  const fullHead = journal.checkpoint;
  await journal.close();
  assert.equal(
    (await verifyJournal(filename, signingKey, { checkpoint: firstHead }))
      .records,
    2,
  );
  await truncate(filename, firstSize);
  assert.equal((await verifyJournal(filename, signingKey)).records, 1);
  await assert.rejects(
    verifyJournal(filename, signingKey, { checkpoint: fullHead }),
    /verification failed/,
  );
  await assert.rejects(
    AuditJournal.open({ directory, signingKey, checkpoint: fullHead }),
    /verification failed/,
  );
  await assert.rejects(
    verifyJournal(filename, signingKey, {
      checkpoint: { ...firstHead, hash: EMPTY_HASH },
    }),
    /verification failed/,
  );
});

test("only one writer can open a journal and file permissions remain private", async (t) => {
  const directory = await temporary(t);
  const journal = await AuditJournal.open({ directory, signingKey });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const filename of [JOURNAL_NAME, LOCK_NAME])
    assert.equal(
      (await stat(path.join(directory, filename))).mode & 0o777,
      0o600,
    );
  await assert.rejects(AuditJournal.open({ directory, signingKey }), {
    code: "EEXIST",
  });
  await journal.close();
  const reopened = await AuditJournal.open({ directory, signingKey });
  await reopened.close();
});

test("journal rejects weak keys, paths inside the application and loose permissions", async (t) => {
  const directory = await temporary(t);
  await assert.rejects(AuditJournal.open({ directory, signingKey: "short" }));
  await assert.rejects(
    AuditJournal.open({ directory: "relative-directory", signingKey }),
  );
  await assert.rejects(
    AuditJournal.open({ directory, signingKey, projectRoot: directory }),
    /outside/,
  );
  await chmod(directory, 0o755);
  await assert.rejects(AuditJournal.open({ directory, signingKey }), /0700/);
  await chmod(directory, 0o700);
  await writeFile(path.join(directory, JOURNAL_NAME), "", { mode: 0o644 });
  await assert.rejects(
    AuditJournal.open({ directory, signingKey }),
    /private regular/,
  );
});

test("journal will not follow a ledger symlink", async (t) => {
  const directory = await temporary(t);
  const target = path.join(directory, "target");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, path.join(directory, JOURNAL_NAME));
  await assert.rejects(AuditJournal.open({ directory, signingKey }));
  assert.equal(await readFile(target, "utf8"), "");
});

test("external truncation makes future writes fail closed", async (t) => {
  const { directory, journal, send } = await fixture(t);
  await journal.append(event());
  await truncate(path.join(directory, JOURNAL_NAME), 0);
  const response = await send(event());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "collector_unavailable" });
  await assert.rejects(journal.append(event()), /unavailable/);
});

test("retries receive no acknowledgment after the retained ledger is truncated, replaced or exposed", async (t) => {
  for (const kind of ["truncate", "replace", "permissions"]) {
    const directory = await temporary(t);
    const journal = await AuditJournal.open({ directory, signingKey });
    cleanup(t, () => journal.close());
    const input = event();
    await journal.append(input);
    const filename = path.join(directory, JOURNAL_NAME);
    if (kind === "truncate") await truncate(filename, 0);
    if (kind === "replace") {
      await rename(filename, filename + ".old");
      await writeFile(filename, "", { mode: 0o600 });
    }
    if (kind === "permissions") await chmod(filename, 0o644);
    await assert.rejects(journal.append(input));
    assert.equal(journal.available, false);
  }
});

test("append copies its input and receipt so callers cannot change committed content", async (t) => {
  const directory = await temporary(t);
  const journal = await AuditJournal.open({ directory, signingKey });
  cleanup(t, () => journal.close());
  const input = event();
  const pending = journal.append(input);
  input.status = 201;
  const receipt = await pending;
  assert.equal(receipt.record.event.status, 200);
  receipt.record.hash = EMPTY_HASH;
  receipt.record.event.status = 202;
  const duplicate = await journal.append({ ...input, status: 200 });
  assert.notEqual(duplicate.record.hash, EMPTY_HASH);
  assert.equal(duplicate.record.event.status, 200);
});

test("CSV exports use stored facts and neutralize spreadsheet formulas", async (t) => {
  const directory = await temporary(t);
  const journal = await AuditJournal.open({ directory, signingKey });
  const { record } = await journal.append(event());
  await journal.close();
  assert.match(csvHeader(), /"summary"/);
  assert.match(csvRecord(record), /"GET \/api\/activity returned 200\."/);
  assert.equal(
    csvCell('=HYPERLINK("https://example.invalid")'),
    '"\'=HYPERLINK(""https://example.invalid"")"',
  );
  for (const text of ["+cmd", "-cmd", "@cmd", "  =cmd", "\t=cmd", "\ncmd"])
    assert.equal(csvCell(text).startsWith("\"'"), true);
  assert.equal(csvCell("plain, text"), '"plain, text"');
});

test("inspection CLI exports verified records and emits no rows on verification failure", async (t) => {
  const directory = await temporary(t);
  const filename = path.join(directory, JOURNAL_NAME);
  const journal = await AuditJournal.open({ directory, signingKey });
  await journal.append(event());
  await journal.close();
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/audit/verify.ts",
        ...args,
        "--file",
        filename,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AUDIT_SIGNING_KEY: signingKey },
      },
    );
  const verified = run("verify");
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Verified 1 audit records/);
  const exported = run("export", "--format", "csv");
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /GET \/api\/activity returned 200/);
  const checkpoint = run("checkpoint");
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  assert.equal(JSON.parse(checkpoint.stdout).sequence, 1);
  await appendFile(filename, "bad\n");
  const broken = run("export");
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, "");
  assert.match(broken.stderr, /Audit inspection failed/);
});
