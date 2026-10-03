import { loadEffectiveRows } from "../src/file-storage";
import { HttpMirrorGateway } from "../src/mirror";
import { sha256Hex } from "../src/canonical";
import { canonicalJson } from "../../packages/nextjs/lib/server/audit-event";
import type { CanonicalDealRecord } from "../src/types";

/**
 * Testnet step 3 — verify a recorded deal against the mirror node.
 *
 *   npm run deal-ledger:verify -- <dealId>
 *
 * Recomputes the record hash from the locally retained JSONL row, fetches the
 * exact topic message from the mirror node, and reports match/mismatch.
 */
async function main() {
  const dealId = process.argv[2];
  if (!dealId) throw new Error("Usage: verify-deal.ts <dealId>");
  const rows = await loadEffectiveRows(".data/deal-ledger.jsonl");
  const entry = rows.get(dealId);
  if (!entry?.receipt) throw new Error(`No confirmed receipt for ${dealId}`);

  const record = entry.canonical_record as CanonicalDealRecord;
  const recomputed = sha256Hex(canonicalJson(record));

  const mirror = HttpMirrorGateway.forNetwork(entry.network);
  const remote = await mirror.fetchTopicMessage(
    entry.receipt.topic_id,
    entry.receipt.sequence_number,
  );
  const payload = JSON.parse(remote.message);

  const problems: string[] = [];
  if (recomputed !== entry.record_sha256) problems.push("local record hash mismatch");
  if (payload.record !== recomputed) problems.push("on-chain record hash mismatch");
  if (remote.consensusTimestamp !== entry.receipt.consensus_timestamp)
    problems.push("consensus timestamp mismatch");
  if (!entry.price_disclosed && payload.price !== undefined)
    problems.push("price present on-chain despite confidential marking");

  console.log(problems.length === 0 ? "✅ VERIFIED — on-chain marker matches the retained record" : "❌ MISMATCH");
  console.log(JSON.stringify({ recomputed, on_chain: payload, consensus: remote.consensusTimestamp, problems }, null, 2));
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
