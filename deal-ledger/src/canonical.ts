import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/nextjs/lib/server/audit-event";
import type { CanonicalDealRecord, OnChainDealPayload } from "./types";

/** SHA-256 of the canonical JSON encoding (sorted keys, no whitespace). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The record hash is the binding between the private off-chain record and the
 * public on-chain marker. Canonicalization makes the hash independent of key
 * order and formatting, so any holder of the record can recompute it.
 */
export function hashDealRecord(record: CanonicalDealRecord): string {
  if (record.v !== 1) throw new Error("Unsupported record version");
  return sha256Hex(canonicalJson(record));
}

/**
 * ID privacy. Unsalted SHA-256 of a low-entropy ID (an email, "0.0.123", a
 * short deal ref) is reversible by dictionary attack, so public markers use a
 * server-side salt. The salt never goes on-chain; in-app verification holds it.
 */
export function hashId(id: string, salt: string): string {
  if (!salt) throw new Error("ID hash salt is required for hashed ID privacy");
  return `sha256:${sha256Hex(`${salt}:${id}`)}`;
}

export type IdPrivacy = { mode: "plain" } | { mode: "hashed"; salt: string };

function encodeId(id: string, privacy: IdPrivacy): string {
  return privacy.mode === "plain" ? id : hashId(id, privacy.salt);
}

/**
 * Build the exact HCS payload. Rules enforced here:
 *  - `price` is present only when the record carries it (opt-in disclosure);
 *    it is never sent as null or as a redacted placeholder.
 *  - `status` is always "completed"; resales are new sequenced messages whose
 *    canonical record links the prior receipt.
 */
export function buildOnChainPayload(
  record: CanonicalDealRecord,
  privacy: IdPrivacy,
): OnChainDealPayload {
  const payload: OnChainDealPayload = {
    v: 1,
    kind: "lettermanlabs_deal_completion",
    deal: encodeId(record.deal_id, privacy),
    asset: encodeId(record.asset_id, privacy),
    buyer: encodeId(record.buyer_id, privacy),
    seller: encodeId(record.seller_id, privacy),
    record: hashDealRecord(record),
    status: "completed",
    completed_at: record.completed_at,
  };
  if (record.price) payload.price = record.price;
  return payload;
}
