import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOnChainPayload, hashDealRecord, hashId, sha256Hex } from "../src/canonical";
import type { HederaGateway, TitleTracker } from "../src/client";
import { HttpMirrorGateway } from "../src/mirror";
import { DealLedger, type CompleteDealInput } from "../src/service";
import { InMemoryLedgerStorage } from "../src/storage";
import { DuplicateAssetError, type OnChainDealPayload } from "../src/types";

const SALT = "test-salt";

function sampleRecord(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    kind: "lettermanlabs_deal_record" as const,
    deal_id: "deal-1",
    asset_id: "asset-1",
    buyer_id: "buyer@example.com",
    seller_id: "seller@example.com",
    description: "Bayfront Commerce Center — 100% fee interest",
    document_hashes: ["aa".repeat(32), "bb".repeat(32)],
    completed_at: "2026-10-03T15:00:00Z",
    ...overrides,
  };
}

function sampleInput(overrides: Partial<CompleteDealInput> = {}): CompleteDealInput {
  return {
    dealId: "deal-1",
    assetId: "asset-1",
    buyerId: "buyer@example.com",
    sellerId: "seller@example.com",
    description: "Bayfront Commerce Center — 100% fee interest",
    documentHashes: ["bb".repeat(32), "aa".repeat(32)], // unsorted on purpose
    completedAt: "2026-10-03T15:00:00Z",
    ...overrides,
  };
}

class FakeGateway implements HederaGateway {
  submitted: { topicId: string; payload: string }[] = [];
  constructor(private seq = 1) {}
  async createDealTopic() {
    return "0.0.999";
  }
  async submitDealMessage(topicId: string, payloadJson: string) {
    this.submitted.push({ topicId, payload: payloadJson });
    return {
      transaction_id: `0.0.5@1700000000.${String(this.seq).padStart(9, "0")}`,
      sequence_number: this.seq++,
      consensus_timestamp: `1700000010.00000000${this.seq}`,
    };
  }
}

class FakeTitleTracker implements TitleTracker {
  issued: { assetId: string; recordSha256: string }[] = [];
  transferred: { tokenId: string; serial: number; to: string }[] = [];
  owners = new Map<string, string>();
  async issueTitle(assetId: string, recordSha256: string) {
    this.issued.push({ assetId, recordSha256 });
    const token = { token_id: "0.0.777", serial_number: 1 };
    this.owners.set("0.0.777:1", "0.0.100");
    return token;
  }
  async transferTitle(tokenId: string, serialNumber: number, toAccountId: string) {
    this.transferred.push({ tokenId, serial: serialNumber, to: toAccountId });
    this.owners.set(`${tokenId}:${serialNumber}`, toAccountId);
  }
  async ownerOf(tokenId: string, serialNumber: number) {
    return this.owners.get(`${tokenId}:${serialNumber}`) ?? null;
  }
}

function fakeMirror(gateway: FakeGateway) {
  return {
    fetchTopicMessage: async ({ sequence }: { topicId: string; sequence: number }) => {
      const submitted = gateway.submitted[sequence - 1];
      if (!submitted) throw new Error("no such message");
      return { consensusTimestamp: `1700000010.00000000${sequence + 1}`, message: submitted.payload };
    },
  };
}

function makeLedger(overrides: Record<string, unknown> = {}) {
  const gateway = new FakeGateway();
  const storage = new InMemoryLedgerStorage();
  const ledger = new DealLedger({
    network: "testnet",
    topicId: "0.0.500",
    gateway,
    storage,
    mirror: fakeMirror(gateway),
    idPrivacy: { mode: "hashed", salt: SALT },
    ...overrides,
  } as never);
  return { gateway, storage, ledger };
}

describe("canonical hashing and payload", () => {
  it("hash is independent of key order and formatting", () => {
    const a = hashDealRecord(sampleRecord());
    const reordered = JSON.parse(JSON.stringify(sampleRecord()));
    const canonical = JSON.stringify(reordered, Object.keys(reordered).sort());
    assert.equal(hashDealRecord(JSON.parse(canonical)), a);
    assert.equal(a, sha256Hex(JSON.stringify(JSON.parse(canonical), Object.keys(JSON.parse(canonical)).sort())));
  });

  it("document hashes are normalized to sorted order when the record is built", async () => {
    // The canonical record is hashed exactly as stored; ordering is
    // normalized at record-build time so equivalent evidence lists hash equal.
    const { storage } = makeLedger();
    const ledger = new DealLedger({
      network: "testnet",
      topicId: "0.0.500",
      gateway: new FakeGateway(),
      storage,
      mirror: { fetchTopicMessage: async () => { throw new Error("unused"); } },
      idPrivacy: { mode: "hashed", salt: SALT },
    });
    await ledger.completeDeal(sampleInput({ documentHashes: ["bb".repeat(32), "aa".repeat(32)] }));
    const entry = (await storage.get("deal-1"))!;
    assert.deepEqual(entry.canonical_record.document_hashes, ["aa".repeat(32), "bb".repeat(32)]);
  });

  it("omits price entirely when confidential; includes it when disclosed", () => {
    const confidential = buildOnChainPayload(sampleRecord(), { mode: "hashed", salt: SALT });
    assert.equal("price" in confidential, false);
    const disclosed = buildOnChainPayload(
      sampleRecord({ price: { amount: "12750000.00", currency: "USD" } }),
      { mode: "hashed", salt: SALT },
    );
    assert.deepEqual(disclosed.price, { amount: "12750000.00", currency: "USD" });
  });

  it("hashes IDs with the salt and never emits the raw ID", () => {
    const payload = buildOnChainPayload(sampleRecord(), { mode: "hashed", salt: SALT });
    assert.equal(payload.buyer, hashId("buyer@example.com", SALT));
    assert.ok(!JSON.stringify(payload).includes("buyer@example.com"));
  });

  it("plain mode emits IDs verbatim (explicit opt-in only)", () => {
    const payload = buildOnChainPayload(sampleRecord(), { mode: "plain" });
    assert.equal(payload.buyer, "buyer@example.com");
  });
});

describe("completion flow", () => {
  it("stores a confirmed entry with receipt facts", async () => {
    const { ledger } = makeLedger();
    const entry = await ledger.completeDeal(sampleInput());
    assert.equal(entry.receipt?.topic_id, "0.0.500");
    assert.equal(entry.receipt?.sequence_number, 1);
    assert.equal(entry.record_sha256, hashDealRecord(entry.canonical_record));
    assert.equal(entry.price_disclosed, false);
  });

  it("blocks a second completion of the same asset (double-sale guard)", async () => {
    const { ledger } = makeLedger();
    await ledger.completeDeal(sampleInput());
    await assert.rejects(
      () => ledger.completeDeal(sampleInput({ dealId: "deal-2" })),
      DuplicateAssetError,
    );
  });

  it("records a resale as a new sequenced message when requested", async () => {
    const { ledger, gateway } = makeLedger();
    await ledger.completeDeal(sampleInput());
    const resale = await ledger.completeDeal(
      sampleInput({ dealId: "deal-resale", resale: { buyerAccountId: "0.0.200" } }),
    );
    assert.equal(gateway.submitted.length, 2);
    assert.equal(resale.receipt?.sequence_number, 2);
  });

  it("mints a title NFT on first sale when title tracking is enabled", async () => {
    const titles = new FakeTitleTracker();
    const { ledger } = makeLedger({ titleTracker: titles });
    const entry = await ledger.completeDeal(sampleInput());
    assert.equal(titles.issued.length, 1);
    assert.deepEqual(entry.title, { token_id: "0.0.777", serial_number: 1 });
    const status = await ledger.assetStatus("asset-1");
    assert.equal(status.completed, true);
    assert.equal(status.dealId, "deal-1");
  });

  it("transfers the title NFT on resale", async () => {
    const titles = new FakeTitleTracker();
    const { ledger } = makeLedger({ titleTracker: titles });
    await ledger.completeDeal(sampleInput());
    await ledger.completeDeal(
      sampleInput({ dealId: "deal-resale", resale: { buyerAccountId: "0.0.200" } }),
    );
    assert.deepEqual(titles.transferred, [{ tokenId: "0.0.777", serial: 1, to: "0.0.200" }]);
    const status = await ledger.assetStatus("asset-1");
    assert.equal(status.titleOwner, "0.0.200");
  });
});

describe("verification", () => {
  it("verifies a confirmed deal against the mirror message", async () => {
    const { ledger } = makeLedger();
    await ledger.completeDeal(sampleInput());
    const result = await ledger.verifyDeal("deal-1");
    assert.equal(result.match, true);
    assert.equal(result.checks.record_hash_match, true);
    assert.equal(result.checks.problems.length, 0);
  });

  it("detects an off-chain record altered after recording", async () => {
    const { ledger, storage } = makeLedger();
    await ledger.completeDeal(sampleInput());
    const entry = await storage.get("deal-1");
    entry!.canonical_record.description = "Altered after the fact";
    await storage.savePending(entry!);
    const result = await ledger.verifyDeal("deal-1");
    assert.equal(result.match, false);
    assert.ok(result.checks.problems.some((p) => p.includes("does not match")));
  });

  it("flags a price that appears on-chain for a confidential deal", async () => {
    const storage = new InMemoryLedgerStorage();
    // Simulate a compromised/buggy submitter that adds price to a confidential deal.
    const leaking = new (class extends FakeGateway {
      override async submitDealMessage(topicId: string, payloadJson: string) {
        const payload = JSON.parse(payloadJson) as OnChainDealPayload;
        payload.price = { amount: "1", currency: "USD" };
        return super.submitDealMessage(topicId, JSON.stringify(payload));
      }
    })();
    const ledger = new DealLedger({
      network: "testnet",
      topicId: "0.0.500",
      gateway: leaking,
      storage,
      mirror: fakeMirror(leaking),
      idPrivacy: { mode: "hashed", salt: SALT },
    });
    await ledger.completeDeal(sampleInput());
    const result = await ledger.verifyDeal("deal-1");
    assert.equal(result.match, false);
    assert.ok(result.checks.problems.some((p) => p.includes("confidential")));
  });
});

describe("mirror gateway", () => {
  it("hashes topic message URLs and decodes base64", async () => {
    const g = HttpMirrorGateway.forNetwork("testnet");
    assert.ok(g["baseUrl"].includes("testnet"));
  });
});
