import { toEventSelector } from "viem";

export interface ActivityItem {
  sequence: number;
  at: string;
  type: string;
  account?: string;
  amount?: string;
  txHash?: string;
}

/** Reads the HCS activity topic via the mirror node (no wallet needed). */
export async function fetchTopicMessages(mirrorNode: string, topicId: string): Promise<ActivityItem[]> {
  const res = await fetch(`${mirrorNode}/api/v1/topics/${topicId}/messages?order=desc&limit=50`);
  if (!res.ok) throw new Error(`Mirror node request failed: ${res.status}`);
  const json = (await res.json()) as {
    messages?: { consensus_timestamp: string; sequence_number: number; message: string }[];
  };
  return (json.messages ?? []).map(m => {
    let parsed: Partial<Omit<ActivityItem, "sequence" | "at">> = {};
    try {
      parsed = JSON.parse(atob(m.message)) as Omit<ActivityItem, "sequence" | "at">;
    } catch {
      parsed = { type: "raw" };
    }
    return {
      sequence: m.sequence_number,
      at: m.consensus_timestamp,
      type: parsed.type ?? "event",
      account: parsed.account,
      amount: parsed.amount,
      txHash: parsed.txHash,
    };
  });
}

/** Finds recent borrowers by scanning pool `Borrowed` events on the mirror node. */
export async function fetchRecentBorrowers(mirrorNode: string, pool: `0x${string}`): Promise<`0x${string}`[]> {
  const topic0 = toEventSelector("Borrowed(address,uint256)");
  const res = await fetch(
    `${mirrorNode}/api/v1/contracts/${pool}/results/logs?topic0=${topic0}&order=desc&limit=50`,
  );
  if (!res.ok) throw new Error(`Mirror node request failed: ${res.status}`);
  const json = (await res.json()) as { logs?: { topics: string[] }[] };
  const accounts = new Set<`0x${string}`>();
  for (const log of json.logs ?? []) {
    const topic = log.topics[1];
    if (topic && topic.length === 66) {
      accounts.add(`0x${topic.slice(26)}` as `0x${string}`);
    }
  }
  return [...accounts];
}
