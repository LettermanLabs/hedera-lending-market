/**
 * Deal Ledger — shared types.
 *
 * Off-chain record: the full deal (description, documents, parties, price if
 * the workspace chooses to retain it). On-chain payload: the small, opaque
 * marker bound to the record by SHA-256.
 */

export type DealStatus = "completed" | "resold" | "void";

/** The canonical off-chain deal record. Hashed as-is; never submitted to HCS. */
export interface CanonicalDealRecord {
  v: 1;
  kind: "lettermanlabs_deal_record";
  deal_id: string;
  asset_id: string;
  buyer_id: string;
  seller_id: string;
  description: string;
  /** SHA-256 of each uploaded document, in a stable order. */
  document_hashes: string[];
  /** RFC 3339 UTC. */
  completed_at: string;
  /** Present only when the parties chose to disclose. */
  price?: { amount: string; currency: string };
}

/**
 * The exact HCS message payload. `price` is omitted entirely when not
 * disclosed — never sent as null. ID fields are either plain or
 * "sha256:<digest>" depending on the idPrivacy setting.
 */
export interface OnChainDealPayload {
  v: 1;
  kind: "lettermanlabs_deal_completion";
  deal: string;
  asset: string;
  buyer: string;
  seller: string;
  /** SHA-256 of canonicalJson(CanonicalDealRecord). */
  record: string;
  status: "completed";
  completed_at: string;
  price?: { amount: string; currency: string };
}

export interface DealReceipt {
  network: "testnet" | "mainnet";
  topic_id: string;
  transaction_id: string;
  sequence_number: number;
  consensus_timestamp: string;
}

/** The persisted ledger row (Supabase `deal_ledger_entries`, or JSONL locally). */
export interface LedgerEntry {
  deal_id: string;
  asset_id: string;
  buyer_id: string;
  seller_id: string;
  status: DealStatus;
  price_disclosed: boolean;
  canonical_record: CanonicalDealRecord;
  record_sha256: string;
  network: "testnet" | "mainnet";
  receipt: DealReceipt | null;
  /** HTS title tracking (optional). */
  title: { token_id: string; serial_number: number } | null;
}

export class DuplicateAssetError extends Error {
  constructor(assetId: string, existingDealId: string) {
    super(
      `Asset ${assetId} already has a completed ledger entry (deal ${existingDealId}). ` +
        `Record a resale instead of a new completion.`,
    );
    this.name = "DuplicateAssetError";
  }
}

export class LedgerVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerVerificationError";
  }
}
