import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  parseAuditEvent,
  type AuditEvent,
} from "../../packages/nextjs/lib/server/audit-event";

export const EMPTY_HASH = "0".repeat(64);
export const JOURNAL_NAME = "journal.jsonl";
export const LOCK_NAME = ".writer.lock";
const MAX_RECORD_BYTES = 8192;
const defaultProjectRoot = fileURLToPath(new URL("../../", import.meta.url));
const hexHash = /^[0-9a-f]{64}$/;

export interface AuditRecord {
  version: 1;
  sequence: number;
  previous_hash: string;
  recorded_at: string;
  event: AuditEvent;
  signature: string;
  hash: string;
}

export interface AuditCheckpoint {
  version: 1;
  sequence: number;
  hash: string;
}
export interface VerificationResult {
  records: number;
  checkpoint: AuditCheckpoint;
}

export class JournalIntegrityError extends Error {
  constructor() {
    super("Audit journal verification failed.");
  }
}
export class DuplicateEventError extends Error {
  constructor() {
    super("Audit event identifier already exists with different content.");
  }
}

export function validateSecret(
  secret: string | undefined,
  name: string,
): string {
  if (
    !secret ||
    secret.length < 32 ||
    secret.trim() !== secret ||
    /[\r\n\0]/.test(secret)
  )
    throw new Error(
      `${name} must contain at least 32 characters without surrounding whitespace.`,
    );
  return secret;
}

function safeEqual(left: string, right: string): boolean {
  return (
    hexHash.test(left) &&
    hexHash.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function signedRecord(
  sequence: number,
  previousHash: string,
  event: AuditEvent,
  key: string,
): AuditRecord {
  const payload = {
    version: 1 as const,
    sequence,
    previous_hash: previousHash,
    recorded_at: new Date().toISOString(),
    event,
  };
  const signature = createHmac("sha256", key)
    .update(canonicalJson(payload))
    .digest("hex");
  const hash = createHash("sha256")
    .update(canonicalJson({ ...payload, signature }))
    .digest("hex");
  return { ...payload, signature, hash };
}

export function parseCheckpoint(input: unknown): AuditCheckpoint {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new JournalIntegrityError();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "hash,sequence,version" ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    typeof value.hash !== "string" ||
    !hexHash.test(value.hash) ||
    (value.sequence === 0 && value.hash !== EMPTY_HASH)
  )
    throw new JournalIntegrityError();
  return value as unknown as AuditCheckpoint;
}

function verifyRecord(
  input: unknown,
  prior: AuditCheckpoint,
  key: string,
): AuditRecord {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error();
    const item = input as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !==
        "event,hash,previous_hash,recorded_at,sequence,signature,version" ||
      item.version !== 1 ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence !== prior.sequence + 1 ||
      item.previous_hash !== prior.hash ||
      typeof item.recorded_at !== "string" ||
      !Number.isFinite(Date.parse(item.recorded_at)) ||
      new Date(item.recorded_at).toISOString() !== item.recorded_at ||
      typeof item.signature !== "string" ||
      typeof item.hash !== "string"
    )
      throw new Error();
    const event = parseAuditEvent(item.event);
    const payload = {
      version: 1,
      sequence: item.sequence,
      previous_hash: item.previous_hash,
      recorded_at: item.recorded_at,
      event,
    };
    const signature = createHmac("sha256", key)
      .update(canonicalJson(payload))
      .digest("hex");
    const hash = createHash("sha256")
      .update(canonicalJson({ ...payload, signature: item.signature }))
      .digest("hex");
    if (!safeEqual(signature, item.signature) || !safeEqual(hash, item.hash))
      throw new Error();
    return { ...payload, signature, hash } as AuditRecord;
  } catch {
    throw new JournalIntegrityError();
  }
}

async function openPrivateFile(
  filename: string,
  flags: number,
): Promise<FileHandle> {
  const handle = await open(filename, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.nlink !== 1)
      throw new Error(
        "Audit files must be private regular files without additional hard links.",
      );
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function resolvedDestination(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(
      await resolvedDestination(parent),
      path.basename(directory),
    );
  }
}

function requireSeparateDirectory(projectRoot: string, directory: string) {
  const relative = path.relative(projectRoot, directory);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error("AUDIT_LOG_DIR must be outside the application checkout.");
}

async function readRecords(
  handle: FileHandle,
  key: string,
  checkpoint: AuditCheckpoint | undefined,
  visit?: (record: AuditRecord) => void,
): Promise<VerificationResult> {
  let head: AuditCheckpoint = { version: 1, sequence: 0, hash: EMPTY_HASH };
  let checkpointSeen = !checkpoint || checkpoint.sequence === 0;
  const ids = new Set<string>();
  const size = (await handle.stat()).size;
  let pending = Buffer.alloc(0);
  let position = 0;
  const buffer = Buffer.alloc(64 * 1024);
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (!bytesRead) throw new JournalIntegrityError();
    position += bytesRead;
    pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline === 0 || newline > MAX_RECORD_BYTES)
        throw new JournalIntegrityError();
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(line),
        );
      } catch {
        throw new JournalIntegrityError();
      }
      const record = verifyRecord(raw, head, key);
      if (ids.has(record.event.event_id)) throw new JournalIntegrityError();
      ids.add(record.event.event_id);
      head = { version: 1, sequence: record.sequence, hash: record.hash };
      if (checkpoint?.sequence === head.sequence) {
        if (!safeEqual(checkpoint.hash, head.hash))
          throw new JournalIntegrityError();
        checkpointSeen = true;
      }
      visit?.(record);
    }
    if (pending.length > MAX_RECORD_BYTES) throw new JournalIntegrityError();
  }
  if (pending.length || !checkpointSeen || (await handle.stat()).size !== size)
    throw new JournalIntegrityError();
  return { records: head.sequence, checkpoint: head };
}

export async function verifyJournal(
  filename: string,
  signingKey: string,
  options: {
    checkpoint?: AuditCheckpoint;
    onRecord?: (record: AuditRecord) => void;
  } = {},
): Promise<VerificationResult> {
  validateSecret(signingKey, "AUDIT_SIGNING_KEY");
  const checkpoint =
    options.checkpoint === undefined
      ? undefined
      : parseCheckpoint(options.checkpoint);
  const handle = await openPrivateFile(filename, constants.O_RDONLY);
  try {
    return await readRecords(handle, signingKey, checkpoint, options.onRecord);
  } finally {
    await handle.close();
  }
}

export class AuditJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failed = false;
  private closing?: Promise<void>;
  private head: AuditCheckpoint = { version: 1, sequence: 0, hash: EMPTY_HASH };
  private events = new Map<string, { content: string; record: AuditRecord }>();
  private expectedBytes = 0;

  private constructor(
    private readonly directory: string,
    private readonly key: string,
    private readonly file: FileHandle,
    private readonly lock: FileHandle,
  ) {}

  static async open(options: {
    directory: string;
    signingKey: string;
    projectRoot?: string;
    checkpoint?: AuditCheckpoint;
  }): Promise<AuditJournal> {
    validateSecret(options.signingKey, "AUDIT_SIGNING_KEY");
    if (!path.isAbsolute(options.directory))
      throw new Error(
        "AUDIT_LOG_DIR must be an absolute path outside the application checkout.",
      );
    const projectRoot = await realpath(
      options.projectRoot ?? defaultProjectRoot,
    );
    requireSeparateDirectory(
      projectRoot,
      await resolvedDestination(path.resolve(options.directory)),
    );
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(options.directory);
    requireSeparateDirectory(projectRoot, directory);
    const info = await stat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new Error("AUDIT_LOG_DIR must have mode 0700.");
    const lock = await openPrivateFile(
      path.join(directory, LOCK_NAME),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(
        JSON.stringify({
          pid: process.pid,
          started_at: new Date().toISOString(),
        }) + "\n",
      );
      await lock.sync();
      file = await openPrivateFile(
        path.join(directory, JOURNAL_NAME),
        constants.O_RDWR | constants.O_CREAT | constants.O_APPEND,
      );
      const journal = new AuditJournal(
        directory,
        options.signingKey,
        file,
        lock,
      );
      const verified = await readRecords(
        file,
        options.signingKey,
        options.checkpoint === undefined
          ? undefined
          : parseCheckpoint(options.checkpoint),
        (record) => {
          journal.events.set(record.event.event_id, {
            content: canonicalJson(record.event),
            record,
          });
        },
      );
      journal.head = verified.checkpoint;
      journal.expectedBytes = (await file.stat()).size;
      // A prior process may have written a complete row before failing to sync it.
      await file.sync();
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return journal;
    } catch (error) {
      await file?.close();
      await lock.close();
      await unlink(path.join(directory, LOCK_NAME));
      throw error;
    }
  }

  get checkpoint(): AuditCheckpoint {
    return { ...this.head };
  }
  get available(): boolean {
    return !this.closed && !this.failed;
  }

  append(
    input: AuditEvent,
  ): Promise<{ record: AuditRecord; duplicate: boolean }> {
    if (this.closed)
      return Promise.reject(new Error("Audit journal is closed."));
    let event: AuditEvent;
    try {
      event = parseAuditEvent(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const task = this.tail.then(async () => {
      if (this.failed) throw new Error("Audit journal is unavailable.");
      try {
        const [opened, current] = await Promise.all([
          this.file.stat(),
          lstat(path.join(this.directory, JOURNAL_NAME)),
        ]);
        if (
          opened.size !== this.expectedBytes ||
          !current.isFile() ||
          opened.ino !== current.ino ||
          opened.dev !== current.dev ||
          opened.nlink !== 1 ||
          (opened.mode & 0o077) !== 0
        )
          throw new JournalIntegrityError();
      } catch (error) {
        this.failed = true;
        throw error;
      }
      const content = canonicalJson(event);
      const previous = this.events.get(event.event_id);
      if (previous) {
        if (previous.content !== content) throw new DuplicateEventError();
        return { record: structuredClone(previous.record), duplicate: true };
      }
      try {
        if (!Number.isSafeInteger(this.head.sequence + 1))
          throw new Error("Audit sequence limit reached.");
        const record = signedRecord(
          this.head.sequence + 1,
          this.head.hash,
          event,
          this.key,
        );
        const encoded = Buffer.from(canonicalJson(record) + "\n");
        if (encoded.length > MAX_RECORD_BYTES)
          throw new Error("Audit record is too large.");
        await this.file.writeFile(encoded);
        await this.file.sync();
        this.expectedBytes += encoded.length;
        this.head = {
          version: 1,
          sequence: record.sequence,
          hash: record.hash,
        };
        this.events.set(event.event_id, { content, record });
        return { record: structuredClone(record), duplicate: false };
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.tail.then(async () => {
      await this.file.close();
      await this.lock.close();
      await unlink(path.join(this.directory, LOCK_NAME));
    });
    return this.closing;
  }
}
