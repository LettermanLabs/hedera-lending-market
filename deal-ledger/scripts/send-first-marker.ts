import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadOperatorConfig, SdkHederaGateway, SdkTitleTracker } from "../src/client";
import { HttpMirrorGateway } from "../src/mirror";
import { DealLedger } from "../src/service";
import { FileLedgerStorage } from "../src/file-storage";

/**
 * Testnet step 2 — record the first deal marker end to end.
 *
 *   npm run deal-ledger:first-marker
 *
 * Env knobs (all optional):
 *   DEAL_DEMO_PRICE=12750000.00   disclose a price (omit env → confidential)
 *   DEAL_DEMO_DISCLOSE_IDS=1      put plain IDs on-chain (default: sha256 with salt)
 *   ENABLE_TITLE_NFT=1            also mint the HTS title NFT
 *
 * Writes the local ledger to .data/deal-ledger.jsonl and prints the exported
 * public receipt for independent mirror-node verification.
 */
async function main() {
  const config = loadOperatorConfig();
  if (!config.topicId) {
    throw new Error("HEDERA_DEAL_TOPIC_ID missing — run npm run deal-ledger:bootstrap first");
  }
  const disclosePrice = Boolean(process.env.DEAL_DEMO_PRICE);
  const plainIds = process.env.DEAL_DEMO_DISCLOSE_IDS === "1";
  const salt = process.env.HEDERA_ID_HASH_SALT || randomUUID();

  const gateway = new SdkHederaGateway(config);
  try {
    const ledger = new DealLedger({
      network: config.network,
      topicId: config.topicId,
      gateway,
      storage: new FileLedgerStorage(".data/deal-ledger.jsonl"),
      mirror: {
        fetchTopicMessage: async ({ topicId, sequence }) =>
          HttpMirrorGateway.forNetwork(config.network).fetchTopicMessage(topicId, sequence),
      },
      idPrivacy: plainIds ? { mode: "plain" } : { mode: "hashed", salt },
      titleTracker:
        process.env.ENABLE_TITLE_NFT === "1" ? new SdkTitleTracker(config) : undefined,
    });

    const dealId = `deal-${randomUUID().slice(0, 8)}`;
    const entry = await ledger.completeDeal({
      dealId,
      assetId: "bayfront-commerce-center",
      buyerId: "buyer-chris-letterman",
      sellerId: "seller-demo-llc",
      description: "Demo completed sale — Bayfront Commerce Center, Redwood City",
      documentHashes: [
        "9f2d7c1e4a08b3f5d6e1c9a27b4f08d3e5c6a197b2d4e5f608193a4b7c6d5e0f",
      ],
      completedAt: new Date().toISOString(),
      ...(disclosePrice
        ? { price: { amount: process.env.DEAL_DEMO_PRICE!, currency: "USD" } }
        : {}),
    });

    const receipt = {
      schemaVersion: 1,
      kind: "lettermanlabs_deal_public_receipt",
      network: entry.network,
      record_sha256: entry.record_sha256,
      proof: {
        status: "confirmed",
        transaction_id: entry.receipt!.transaction_id,
        topic_id: entry.receipt!.topic_id,
        consensus_timestamp: entry.receipt!.consensus_timestamp,
        sequence_number: entry.receipt!.sequence_number,
        price_disclosed: entry.price_disclosed,
        title: entry.title,
      },
    };
    await writeFile(".data/deal-public-receipt.json", JSON.stringify(receipt, null, 2));
    console.log("✅ Deal marker confirmed on Hedera", config.network);
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`\nVerify independently:`);
    console.log(
      `  curl "https://testnet.mirrornode.hedera.com/api/v1/topics/${entry.receipt!.topic_id}/messages?sequenceNumber=${entry.receipt!.sequence_number}"`,
    );
  } finally {
    gateway.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
