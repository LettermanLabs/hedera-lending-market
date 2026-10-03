import { loadOperatorConfig, SdkHederaGateway } from "../src/client";

/**
 * Testnet step 1 — create the deal-completion topic (once).
 *
 *   cp .env.example .env.local   # fill HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY (testnet)
 *   npm run deal-ledger:bootstrap
 *
 * Prints HEDERA_DEAL_TOPIC_ID; add it to .env.local. The topic is restricted:
 * only the operator key can submit, no custom fees, admin key held by operator.
 */
async function main() {
  const config = loadOperatorConfig();
  if (config.topicId) {
    console.log(`HEDERA_DEAL_TOPIC_ID already set: ${config.topicId}`);
    console.log(`HashScan: https://hashscan.io/${config.network}/topic/${config.topicId}`);
    return;
  }
  const gateway = new SdkHederaGateway(config);
  try {
    const topicId = await gateway.createDealTopic();
    console.log(`✅ Deal ledger topic created: ${topicId}`);
    console.log(`   Add to .env.local:  HEDERA_DEAL_TOPIC_ID=${topicId}`);
    console.log(`   HashScan: https://hashscan.io/${config.network}/topic/${topicId}`);
  } finally {
    gateway.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
