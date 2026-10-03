import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerEntry } from "../src/types";
import type { LedgerStorage } from "../src/storage";
import { InMemoryLedgerStorage } from "../src/storage";

/** JSONL store so the CLI scripts persist state across runs without a database. */
export class FileLedgerStorage extends InMemoryLedgerStorage implements LedgerStorage {
  private loaded = false;

  constructor(private readonly file: string) {
    super();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as LedgerEntry;
        await super.savePending(row);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  override async savePending(entry: LedgerEntry): Promise<void> {
    await this.ensureLoaded();
    await super.savePending(entry);
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
  }

  override async get(dealId: string): Promise<LedgerEntry | null> {
    await this.ensureLoaded();
    return super.get(dealId);
  }

  override async findCompletedByAsset(assetId: string): Promise<LedgerEntry | null> {
    await this.ensureLoaded();
    return super.findCompletedByAsset(assetId);
  }

  override async markConfirmed(
    dealId: string,
    receipt: LedgerEntry["receipt"],
    title: LedgerEntry["title"],
  ): Promise<void> {
    await this.ensureLoaded();
    await super.markConfirmed(dealId, receipt, title);
    await mkdir(path.dirname(this.file), { recursive: true });
    const row = await super.get(dealId);
    await appendFile(this.file, JSON.stringify({ ...row, __amend__: dealId }) + "\n", "utf8");
  }
}

/** Later amendments win when replaying a JSONL file. */
export async function loadEffectiveRows(file: string): Promise<Map<string, LedgerEntry>> {
  const rows = new Map<string, LedgerEntry>();
  try {
    const raw = await readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as LedgerEntry & { __amend__?: string };
      rows.set(row.__amend__ ?? row.deal_id, row);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return rows;
}
