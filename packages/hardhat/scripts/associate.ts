/**
 * Associates the operator account with USDX + WHBAR so a wallet keyed by
 * HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY can hold and transfer the tokens.
 *
 * Run: npm run associate
 */
import { TokenAssociateTransaction } from "@hiero-ledger/sdk";
import { hederaClient, requireEnv } from "./lib/setup";
import { loadDeployment } from "./lib/record";

const WHBAR_TOKEN_ID = "0.0.15058";

async function associateIfNeeded(tokenId: string): Promise<void> {
  const client = hederaClient();
  const { accountId, operatorKey } = requireEnv();
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([tokenId])
      .freezeWith(client)
      .sign(operatorKey);
    await (await tx.execute(client)).getReceipt(client);
    console.log(`✅ associated ${tokenId}`);
  } catch {
    console.log(`ℹ️  already associated with ${tokenId}`);
  }
}

async function main() {
  const record = loadDeployment();
  if (!record) throw new Error("No deployment found — run `npm run deploy` first.");
  await associateIfNeeded(record.usdxTokenId);
  await associateIfNeeded(WHBAR_TOKEN_ID);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
