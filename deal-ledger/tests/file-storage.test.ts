import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileLedgerStorage } from "../src/file-storage";
import { DuplicateAssetError, type LedgerEntry } from "../src/types";

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    deal_id: "deal-1",
    asset_id: "asset-1",
    buyer_id: "b",
    seller_id: "s",
    status: "completed",
    price_disclosed: false,
    canonical_record: {
      v: 1,
      kind: "lettermanlabs_deal_record",
      deal_id: "deal-1",
      asset_id: "asset-1",
      buyer_id: "b",
      seller_id: "s",
      description: "d",
      document_hashes: [],
      completed_at: "2026-10-03T00:00:00Z",
    },
    record_sha256: "aa".repeat(32),
    network: "testnet",
    receipt: {
      network: "testnet",
      topic_id: "0.0.500",
      transaction_id: "0.0.5@1.1",
      sequence_number: 1,
      consensus_timestamp: "1.1",
    },
    title: null,
    ...overrides,
  };
}

describe("FileLedgerStorage", () => {
  it("a fresh instance sees completed assets written by a prior process", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deal-ledger-"));
    const file = path.join(dir, "ledger.jsonl");
    try {
      const first = new FileLedgerStorage(file);
      await first.savePending(entry());
      // Read paths must trigger the lazy load — the double-sale guard depends on it.
      const second = new FileLedgerStorage(file);
      const found = await second.findCompletedByAsset("asset-1");
      assert.equal(found?.deal_id, "deal-1");
      assert.equal((await second.get("deal-1"))?.record_sha256, "aa".repeat(32));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("amendments replay so markConfirmed survives a reload", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deal-ledger-"));
    const file = path.join(dir, "ledger.jsonl");
    try {
      const writer = new FileLedgerStorage(file);
      await writer.savePending({ ...entry(), receipt: null });
      await writer.markConfirmed("deal-1", entry().receipt, null);
      const reloaded = new FileLedgerStorage(file);
      const row = await reloaded.get("deal-1");
      assert.equal(row?.receipt?.sequence_number, 1);
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      assert.equal(lines.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("DuplicateAssetError message names the prior deal", () => {
    const err = new DuplicateAssetError("asset-9", "deal-7");
    assert.match(err.message, /asset-9/);
    assert.match(err.message, /deal-7/);
  });
});
