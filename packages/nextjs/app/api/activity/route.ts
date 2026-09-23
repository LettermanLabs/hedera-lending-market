import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TopicMessageSubmitTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import { resolve } from "node:path";
import { ActivityStore } from "../../../lib/server/activity-store";
import { createActivityHandler } from "../../../lib/server/activity-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let handler: ReturnType<typeof createActivityHandler> | undefined;

/** Reports whether optional HCS mirroring is configured. Never returns credentials. */
export function GET() {
  const topicId = process.env.NEXT_PUBLIC_HCS_TOPIC_ID || null;
  const configured = Boolean(
    process.env.HEDERA_ACCOUNT_ID &&
    process.env.HEDERA_PRIVATE_KEY &&
    topicId &&
    process.env.NEXT_PUBLIC_LENDING_POOL,
  );
  return Response.json(
    { ok: true, configured, topicId },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  const topicId = process.env.NEXT_PUBLIC_HCS_TOPIC_ID;
  const pool = process.env.NEXT_PUBLIC_LENDING_POOL;
  if (!accountId || !privateKey || !topicId || !pool)
    return Response.json(
      {
        ok: false,
        error:
          "Optional HCS mirroring is not configured. Set server operator credentials, pool and topic in packages/nextjs/.env.local.",
      },
      { status: 503 },
    );
  try {
    if (!handler) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(pool) || !/^0\.0\.\d+$/.test(topicId))
        throw new Error("Invalid configuration");
      const rawKey = privateKey.replace(/^0x/, "");
      const key = /^[0-9a-fA-F]{64}$/.test(rawKey)
        ? PrivateKey.fromStringECDSA(rawKey)
        : PrivateKey.fromStringDer(rawKey);
      const operator = AccountId.fromString(accountId);
      const store = new ActivityStore(
        resolve(process.env.ACTIVITY_STORE_DIR || ".data/activity"),
        `296:${pool.toLowerCase()}:${topicId}`,
      );
      handler = createActivityHandler({
        pool,
        topicId,
        mirrorNode: "https://testnet.mirrornode.hedera.com",
        submitKey: key.publicKey.toStringRaw(),
        store,
        prepare(message) {
          const id = TransactionId.generate(operator);
          return {
            id: id.toString(),
            async send() {
              const client = Client.forTestnet()
                .setOperator(operator, key)
                .setDefaultMaxTransactionFee(new Hbar(0.5));
              try {
                const tx = await new TopicMessageSubmitTransaction()
                  .setTopicId(topicId)
                  .setTransactionId(id)
                  .setMaxChunks(1)
                  .setMaxTransactionFee(new Hbar(0.5))
                  .setMessage(JSON.stringify(message))
                  .execute(client);
                const receipt = await tx.getReceipt(client);
                if (!receipt.topicSequenceNumber)
                  throw new Error("Missing HCS sequence");
                return receipt.topicSequenceNumber.toString();
              } finally {
                client.close();
              }
            },
          };
        },
      });
    }
    return handler(request);
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "HCS server configuration is invalid. Check the operator key and activity storage.",
      },
      { status: 503 },
    );
  }
}
