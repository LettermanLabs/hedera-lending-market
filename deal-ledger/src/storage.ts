import type { LedgerEntry } from "./types";

/** Persisted store for ledger rows. Production: the Supabase schema in db/schema.sql. */
export interface LedgerStorage {
  savePending(entry: LedgerEntry): Promise<void>;
  markConfirmed(dealId: string, receipt: LedgerEntry["receipt"], title: LedgerEntry["title"]): Promise<void>;
  get(dealId: string): Promise<LedgerEntry | null>;
  /** The active completed entry for an asset, if any — the double-sale guard. */
  findCompletedByAsset(assetId: string): Promise<LedgerEntry | null>;
}

export class InMemoryLedgerStorage implements LedgerStorage {
  private readonly rows = new Map<string, LedgerEntry>();

  async savePending(entry: LedgerEntry): Promise<void> {
    this.rows.set(entry.deal_id, structuredClone(entry));
  }

  async markConfirmed(
    dealId: string,
    receipt: LedgerEntry["receipt"],
    title: LedgerEntry["title"],
  ): Promise<void> {
    const row = this.rows.get(dealId);
    if (!row) throw new Error(`Unknown deal ${dealId}`);
    row.receipt = receipt;
    row.title = title;
  }

  async get(dealId: string): Promise<LedgerEntry | null> {
    const row = this.rows.get(dealId);
    return row ? structuredClone(row) : null;
  }

  async findCompletedByAsset(assetId: string): Promise<LedgerEntry | null> {
    for (const row of this.rows.values()) {
      if (row.asset_id === assetId && row.status === "completed") {
        return structuredClone(row);
      }
    }
    return null;
  }
}
