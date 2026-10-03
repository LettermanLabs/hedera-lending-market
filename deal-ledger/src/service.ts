import { buildOnChainPayload, hashDealRecord, type IdPrivacy } from "./canonical";
import type { HederaGateway, TitleTracker } from "./client";
import { canonicalJson } from "../../packages/nextjs/lib/server/audit-event";
import type { LedgerStorage } from "./storage";
import { DuplicateAssetError, type DealReceipt, type LedgerEntry, type OnChainDealPayload } from "./types";

export interface CompleteDealInput {
  dealId: string;
  assetId: string;
  buyerId: string;
  sellerId: string;
  description: string;
  documentHashes: string[];
  completedAt: string;
  /** Omit to keep the price confidential — the on-chain payload has no price field at all. */
  price?: { amount: string; currency: string };
  /** Set for a resale: skips the double-sale block and transfers the title NFT. */
  resale?: { buyerAccountId: string };
}

export interface VerifyResult {
  match: boolean;
  checks: {
    record_hash_match: boolean;
    consensus_timestamp: string;
    sequence_number: number;
    payload: OnChainDealPayload | null;
    problems: string[];
  };
}

export interface DealLedgerDeps {
  network: "testnet" | "mainnet";
  topicId: string;
  gateway: HederaGateway;
  storage: LedgerStorage;
  mirror: { fetchTopicMessage(g: { topicId: string; sequence: number }): Promise<{ consensusTimestamp: string; message: string }> };
  idPrivacy: IdPrivacy;
  /** HTS title tracking; omit to record HCS-only receipts. */
  titleTracker?: TitleTracker;
}

/**
 * Completion flow:
 *   1. Double-sale guard — an asset with a completed entry cannot complete again.
 *   2. Build the canonical record, hash it, persist the row as pending.
 *   3. Submit the small payload to the HCS topic (operator signs and pays).
 *   4. If title tracking is on: mint (first sale) or transfer (resale) the NFT.
 *   5. Persist transaction id, sequence, consensus timestamp; return the entry.
 *
 * A failure after the HCS submission leaves the row pending with no receipt;
 * reconcile with reconcileDeal() against the original transaction — the same
 * no-silent-replacement policy as the financing desk.
 */
export class DealLedger {
  constructor(private readonly deps: DealLedgerDeps) {}

  async completeDeal(input: CompleteDealInput): Promise<LedgerEntry> {
    const existing = await this.deps.storage.findCompletedByAsset(input.assetId);
    if (existing && !input.resale) {
      throw new DuplicateAssetError(input.assetId, existing.deal_id);
    }

    const canonical_record = {
      v: 1 as const,
      kind: "lettermanlabs_deal_record" as const,
      deal_id: input.dealId,
      asset_id: input.assetId,
      buyer_id: input.buyerId,
      seller_id: input.sellerId,
      description: input.description,
      document_hashes: [...input.documentHashes].sort(),
      completed_at: input.completedAt,
      ...(input.price ? { price: input.price } : {}),
    };
    const record_sha256 = hashDealRecord(canonical_record);
    const payload = buildOnChainPayload(canonical_record, this.deps.idPrivacy);

    const entry: LedgerEntry = {
      deal_id: input.dealId,
      asset_id: input.assetId,
      buyer_id: input.buyerId,
      seller_id: input.sellerId,
      status: "completed",
      price_disclosed: Boolean(input.price),
      canonical_record,
      record_sha256,
      network: this.deps.network,
      receipt: null,
      title: existing?.title ?? null,
    };
    await this.deps.storage.savePending(entry);

    const submitted = await this.deps.gateway.submitDealMessage(
      this.deps.topicId,
      canonicalJson(payload),
    );
    const receipt: DealReceipt = {
      network: this.deps.network,
      topic_id: this.deps.topicId,
      transaction_id: submitted.transaction_id,
      sequence_number: submitted.sequence_number,
      consensus_timestamp: submitted.consensus_timestamp,
    };

    let title = entry.title;
    if (this.deps.titleTracker) {
      if (input.resale) {
        await this.transferTitle(input, existing!);
        title = entry.title;
      } else {
        title = await this.deps.titleTracker.issueTitle(input.assetId, record_sha256);
      }
    }

    await this.deps.storage.markConfirmed(input.dealId, receipt, title);
    return { ...entry, receipt, title };
  }

  private async transferTitle(
    input: CompleteDealInput,
    existing: LedgerEntry,
  ): Promise<void> {
    if (!existing.title) throw new Error(`Asset ${input.assetId} has no title NFT to transfer`);
    await this.deps.titleTracker!.transferTitle(
      existing.title.token_id,
      existing.title.serial_number,
      input.resale!.buyerAccountId,
    );
  }

  /**
   * Verify a deal against the network: recompute the record hash locally and
   * compare it with the payload actually recorded on HCS. Detection, not
   * prevention — a mismatch means the off-chain record was altered after the
   * fact, which is exactly the fraud signal this ledger exists to surface.
   */
  async verifyDeal(dealId: string): Promise<VerifyResult> {
    const entry = await this.deps.storage.get(dealId);
    if (!entry?.receipt) throw new Error(`Deal ${dealId} has no confirmed receipt`);

    const recomputed = hashDealRecord(entry.canonical_record);
    const remote = await this.deps.mirror.fetchTopicMessage({
      topicId: entry.receipt.topic_id,
      sequence: entry.receipt.sequence_number,
    });

    const problems: string[] = [];
    let payload: OnChainDealPayload | null = null;
    try {
      payload = JSON.parse(remote.message) as OnChainDealPayload;
    } catch {
      problems.push("On-chain message is not valid JSON");
    }

    const record_hash_match = recomputed === entry.record_sha256 && payload?.record === recomputed;
    if (recomputed !== entry.record_sha256)
      problems.push("Stored record hash does not match the stored record — local tampering");
    if (payload && payload.record !== recomputed)
      problems.push("On-chain record hash does not match the recomputed hash");
    if (payload && payload.status !== "completed") problems.push("On-chain status is not completed");
    if (payload && !entry.price_disclosed && payload.price !== undefined)
      problems.push("Price present on-chain for a deal recorded as confidential");
    if (remote.consensusTimestamp !== entry.receipt.consensus_timestamp)
      problems.push("Consensus timestamp differs from the stored receipt");

    return {
      match: problems.length === 0,
      checks: {
        record_hash_match,
        consensus_timestamp: remote.consensusTimestamp,
        sequence_number: entry.receipt.sequence_number,
        payload,
        problems,
      },
    };
  }

  /** Pre-completion double-sale check for the UI: current ledger state of an asset. */
  async assetStatus(assetId: string): Promise<{ completed: boolean; dealId: string | null; titleOwner: string | null }> {
    const existing = await this.deps.storage.findCompletedByAsset(assetId);
    let titleOwner: string | null = null;
    if (existing?.title && this.deps.titleTracker) {
      titleOwner = await this.deps.titleTracker.ownerOf(
        existing.title.token_id,
        existing.title.serial_number,
      );
    }
    return {
      completed: Boolean(existing),
      dealId: existing?.deal_id ?? null,
      titleOwner,
    };
  }
}
