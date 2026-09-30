import { constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAuditEvent,
  parseAuditEvent,
  type AuditEvent,
  type AuditInput,
} from "./audit-event";

export interface AuditDeliverySummary {
  pending: number;
  delivered: number;
  oldest_pending_at?: string | null;
  oldest_pending_age_seconds?: number | null;
  temporary_files?: number;
}

export interface AuditWriter {
  record(input: AuditInput): Promise<void>;
  flush(): Promise<AuditDeliverySummary>;
}

export interface AuditWriterConfig {
  mode?: string;
  collectorUrl?: string;
  collectorToken?: string;
  outboxDir?: string;
  activityStoreDir?: string;
  auditLogDir?: string;
  repositoryRoot?: string;
  maxPending?: number;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger?: (line: string) => void;
}

export class AuditConfigurationError extends Error {
  constructor() {
    super("Audit logging configuration is invalid");
    this.name = "AuditConfigurationError";
  }
}

export class AuditUnavailableError extends Error {
  constructor() {
    super("Audit logging is unavailable");
    this.name = "AuditUnavailableError";
  }
}

const eventFile =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const queues = new Map<string, Promise<unknown>>();
const deliveries = new Map<string, Promise<unknown>>();
// A request can emit start, two HCS records, and completion. Keep room for all four
// before its handler runs, even if the collector remains unavailable throughout.
const requestReservations = new Map<string, Map<string, number>>();
const requestRecordLimit = 4;

async function serial<T>(
  map: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = map.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(task);
  map.set(key, current);
  try {
    return await current;
  } finally {
    if (map.get(key) === current) map.delete(key);
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function repositoryRoot(): string {
  let directory = resolve(process.cwd());
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (Array.isArray(manifest.workspaces)) return directory;
    } catch {
      /* A deployed app may not have a repository checkout. */
    }
    const parent = dirname(directory);
    if (parent === directory) return resolve(process.cwd());
    directory = parent;
  }
}

/** Resolve existing ancestors too, so a symlink cannot hide an application-data path. */
function physicalPath(value: string): string {
  let current = resolve(value);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new AuditConfigurationError();
    missing.unshift(relative(parent, current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return (
    remainder === "" ||
    (!remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      remainder !== ".." &&
      !isAbsolute(remainder))
  );
}

function overlap(first: string, second: string): boolean {
  return contains(first, second) || contains(second, first);
}

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum)
    throw new AuditConfigurationError();
  return result;
}

function configFor(input: AuditWriterConfig) {
  try {
    if (
      !input.collectorUrl ||
      !input.collectorToken ||
      input.collectorToken.length < 32 ||
      /[\s\x00-\x1f\x7f]/.test(input.collectorToken) ||
      !input.outboxDir ||
      !isAbsolute(input.outboxDir)
    )
      throw new AuditConfigurationError();
    const url = new URL(input.collectorUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#") ||
      url.pathname !== "/v1/events"
    )
      throw new AuditConfigurationError();
    const directory = physicalPath(input.outboxDir);
    const root = physicalPath(input.repositoryRoot ?? repositoryRoot());
    if (
      overlap(directory, root) ||
      (input.activityStoreDir &&
        overlap(directory, physicalPath(input.activityStoreDir))) ||
      (input.auditLogDir && overlap(directory, physicalPath(input.auditLogDir)))
    )
      throw new AuditConfigurationError();
    return {
      directory,
      endpoint: url.toString(),
      token: input.collectorToken,
      maxPending: bounded(input.maxPending, 10_000, 100_000),
      batchSize: bounded(input.batchSize, 100, 100),
      timeoutMs: bounded(input.timeoutMs, 2_000, 2_000),
      request: input.fetch ?? fetch,
      logger: input.logger ?? ((line: string) => console.error(line)),
    };
  } catch {
    throw new AuditConfigurationError();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(directory: string): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (code(error) === "ENOENT") {
      await privateDirectory(dirname(directory));
      await privateDirectory(directory);
      return;
    }
    if (code(error) !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new AuditUnavailableError();
  if (created) await syncDirectory(dirname(directory));
}

async function privateRecord(path: string): Promise<AuditEvent> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 4_096 ||
      (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new AuditUnavailableError();
    return parseAuditEvent(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

async function acknowledged(response: Response, id: string): Promise<boolean> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    return false;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1_024) return false;
      chunks.push(item.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (
      !!result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      (result as Record<string, unknown>).ok === true &&
      (result as Record<string, unknown>).event_id === id
    );
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function createAuditWriter(input: AuditWriterConfig = {}): AuditWriter {
  const mode = input.mode ?? "off";
  if (mode === "off") {
    return {
      async record() {},
      async flush() {
        return { pending: 0, delivered: 0 };
      },
    };
  }
  if (mode !== "required") throw new AuditConfigurationError();
  const config = configFor(input);
  let failures = 0;

  function warn(event: AuditEvent) {
    failures++;
    try {
      config.logger(
        JSON.stringify({
          component: "audit-delivery",
          delivery_failures: failures,
          request_id: event.request_id,
        }),
      );
    } catch {
      /* Logging an unavailable collector must not discard its outbox record. */
    }
  }

  async function send(event: AuditEvent): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await config.request(config.endpoint, {
            method: "POST",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.token}`,
            },
            body: JSON.stringify(event),
          });
          return acknowledged(response, event.event_id);
        })(),
        new Promise<false>((resolveTimeout) => {
          timer = setTimeout(() => {
            controller.abort();
            resolveTimeout(false);
          }, config.timeoutMs);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function files(): Promise<string[]> {
    const entries = await readdir(config.directory);
    // Unfinished writes count toward capacity; they are never treated as accepted events.
    if (
      entries.some(
        (name) => !eventFile.test(name) && !/^\.pending-[0-9a-f-]+$/.test(name),
      )
    )
      throw new AuditUnavailableError();
    return entries;
  }

  async function persist(event: AuditEvent): Promise<void> {
    await serial(queues, config.directory, async () => {
      await privateDirectory(config.directory);
      const reservations =
        requestReservations.get(config.directory) ?? new Map<string, number>();
      const starting = event.action === "request.started";
      if (starting && reservations.has(event.request_id))
        throw new AuditUnavailableError();
      const remaining = reservations.get(event.request_id) ?? 0;
      const outstanding = [...reservations.values()].reduce(
        (total, count) => total + count,
        0,
      );
      const additional = starting ? requestRecordLimit : remaining > 0 ? 0 : 1;
      if ((await files()).length + outstanding + additional > config.maxPending)
        throw new AuditUnavailableError();
      if (starting) {
        reservations.set(event.request_id, requestRecordLimit);
        requestReservations.set(config.directory, reservations);
      }
      const temporary = join(config.directory, `.pending-${event.event_id}`);
      const destination = join(config.directory, `${event.event_id}.json`);
      let renamed = false;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        // UUID filenames plus the exclusive temporary create prevent writers from replacing an event.
        try {
          await lstat(destination);
          throw new AuditUnavailableError();
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
        }
        await rename(temporary, destination);
        renamed = true;
        await syncDirectory(config.directory);
        if (event.action === "request.completed")
          reservations.delete(event.request_id);
        else if ((reservations.get(event.request_id) ?? 0) > 0)
          reservations.set(
            event.request_id,
            reservations.get(event.request_id)! - 1,
          );
      } catch (error) {
        if (starting) reservations.delete(event.request_id);
        else if (renamed && remaining > 0)
          reservations.set(event.request_id, remaining - 1);
        throw error;
      } finally {
        await handle?.close().catch(() => {});
        if (!renamed) await unlink(temporary).catch(() => {});
        if (reservations.size === 0)
          requestReservations.delete(config.directory);
      }
    });
  }

  async function snapshot() {
    const names = await files();
    const events: Array<{ name: string; occurredAt: string }> = [];
    for (const name of names.filter((entry) => eventFile.test(entry))) {
      try {
        const event = await privateRecord(join(config.directory, name));
        if (`${event.event_id}.json` !== name)
          throw new AuditUnavailableError();
        events.push({ name, occurredAt: event.occurred_at });
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
    }
    events.sort(
      (first, second) =>
        Date.parse(first.occurredAt) - Date.parse(second.occurredAt) ||
        first.name.localeCompare(second.name),
    );
    return {
      events,
      temporaryFiles: names.filter((name) => !eventFile.test(name)).length,
    };
  }

  async function deliver(names: string[]): Promise<number> {
    let delivered = 0;
    for (const name of names) {
      const path = join(config.directory, name);
      let event: AuditEvent;
      try {
        event = await privateRecord(path);
        if (`${event.event_id}.json` !== name)
          throw new AuditUnavailableError();
      } catch (error) {
        if (code(error) === "ENOENT") continue; // A separate replay process acknowledged it first.
        throw new AuditUnavailableError();
      }
      if (!(await send(event))) {
        warn(event);
        break;
      }
      await serial(queues, config.directory, async () => {
        try {
          await unlink(path);
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
        }
        await syncDirectory(config.directory);
      });
      delivered++;
    }
    return delivered;
  }

  return {
    async record(inputEvent) {
      let event: AuditEvent;
      try {
        event = createAuditEvent(inputEvent);
        await persist(event);
      } catch {
        throw new AuditUnavailableError();
      }
      // A request pays for at most its own delivery attempt. Backlog replay is a separate job.
      try {
        await deliver([`${event.event_id}.json`]);
      } catch {
        warn(event);
      }
    },
    async flush() {
      try {
        return await serial(deliveries, config.directory, async () => {
          await privateDirectory(config.directory);
          const before = await snapshot();
          const delivered = await deliver(
            before.events.slice(0, config.batchSize).map((event) => event.name),
          );
          const after = await snapshot();
          const oldest = after.events[0]?.occurredAt ?? null;
          return {
            pending: after.events.length + after.temporaryFiles,
            delivered,
            oldest_pending_at: oldest,
            oldest_pending_age_seconds:
              oldest === null
                ? null
                : Math.max(
                    0,
                    Math.floor((Date.now() - Date.parse(oldest)) / 1_000),
                  ),
            temporary_files: after.temporaryFiles,
          };
        });
      } catch {
        throw new AuditUnavailableError();
      }
    },
  };
}

let cached: { key: string; writer: AuditWriter } | undefined;

export function getAuditWriter(): AuditWriter {
  const input: AuditWriterConfig = {
    mode: process.env.AUDIT_MODE ?? "off",
    collectorUrl: process.env.AUDIT_COLLECTOR_URL,
    collectorToken: process.env.AUDIT_COLLECTOR_TOKEN,
    outboxDir: process.env.AUDIT_OUTBOX_DIR,
    activityStoreDir: process.env.ACTIVITY_STORE_DIR,
    auditLogDir: process.env.AUDIT_LOG_DIR,
    maxPending:
      process.env.AUDIT_OUTBOX_MAX_RECORDS === undefined
        ? undefined
        : Number(process.env.AUDIT_OUTBOX_MAX_RECORDS),
    batchSize:
      process.env.AUDIT_FLUSH_BATCH_SIZE === undefined
        ? undefined
        : Number(process.env.AUDIT_FLUSH_BATCH_SIZE),
  };
  const key = JSON.stringify(input);
  if (!cached || cached.key !== key)
    cached = { key, writer: createAuditWriter(input) };
  return cached.writer;
}
