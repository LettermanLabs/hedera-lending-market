import { NextResponse } from "next/server";
import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

/**
 * Mirrors market activity to the HCS topic. Server-side only: the operator key
 * never leaves the environment. Without credentials the app still works — this
 * endpoint just reports 503 and the UI treats HCS mirroring as best-effort.
 */
export async function POST(request: Request) {
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  const topicId = process.env.NEXT_PUBLIC_HCS_TOPIC_ID;

  if (!accountId || !privateKey || !topicId) {
    return NextResponse.json(
      { ok: false, error: "HCS mirroring not configured (missing HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY/topic)." },
      { status: 503 },
    );
  }

  let body: { type?: string; account?: string; amount?: string; txHash?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!body.type || typeof body.type !== "string" || body.type.length > 40) {
    return NextResponse.json({ ok: false, error: "type is required" }, { status: 400 });
  }

  const message = JSON.stringify({
    type: body.type,
    account: body.account,
    amount: body.amount,
    txHash: body.txHash,
    at: new Date().toISOString(),
  });

  try {
    const client = Client.forTestnet().setOperator(
      AccountId.fromString(accountId),
      PrivateKey.fromString(privateKey),
    );
    const tx = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).execute(client);
    const receipt = await tx.getReceipt(client);
    return NextResponse.json({ ok: true, sequence: receipt.topicSequenceNumber?.toString() ?? null });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
