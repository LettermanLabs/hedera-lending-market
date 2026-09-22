import { isAddress, toEventSelector } from "viem";

export interface ActivityItem {
  sequence: number;
  at: string;
  type: string;
  account?: string;
  amount?: string;
  txHash?: string;
}

function textField(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length <= maxLength
    ? value
    : undefined;
}

export function parseTopicMessage(
  message: unknown,
  sequence: unknown,
  at: unknown,
): ActivityItem | null {
  if (
    typeof message !== "string" ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    typeof at !== "string"
  )
    return null;
  let parsed: Record<string, unknown> = {};
  try {
    const bytes = Uint8Array.from(atob(message), (character) =>
      character.charCodeAt(0),
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value))
      parsed = value as Record<string, unknown>;
  } catch {
    // Public topics can include messages from other clients. Render them as raw entries.
  }
  const txHash = textField(parsed.txHash);
  return {
    sequence,
    at,
    type: textField(parsed.type, 80) ?? "unrecognized message",
    account: textField(parsed.account, 80),
    amount: textField(parsed.amount, 100),
    txHash: txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : undefined,
  };
}

/** The activity page intentionally shows the most recent 50 HCS messages. */
export async function fetchTopicMessages(
  mirrorNode: string,
  topicId: string,
  signal?: AbortSignal,
): Promise<ActivityItem[]> {
  if (!/^0\.0\.\d+$/.test(topicId))
    throw new Error("The HCS topic ID is invalid.");
  const res = await fetch(
    `${mirrorNode.replace(/\/$/, "")}/api/v1/topics/${topicId}/messages?order=desc&limit=50`,
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`Mirror node request failed: ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.messages))
    throw new Error("The mirror node returned an invalid topic response.");
  return json.messages.flatMap(
    (message: {
      message?: unknown;
      sequence_number?: unknown;
      consensus_timestamp?: unknown;
    }) => {
      const item = parseTopicMessage(
        message.message,
        message.sequence_number,
        message.consensus_timestamp,
      );
      return item ? [item] : [];
    },
  );
}

/** Page all pool logs, filtering locally: mirror topic filters require a time range. */
export async function fetchRecentBorrowers(
  mirrorNode: string,
  pool: `0x${string}`,
  signal?: AbortSignal,
): Promise<`0x${string}`[]> {
  if (!isAddress(pool)) throw new Error("The pool address is invalid.");
  const base = new URL(mirrorNode);
  const logPath = `/api/v1/contracts/${pool}/results/logs`;
  const borrowedSelector = toEventSelector("Borrowed(address,uint256)").slice(
    2,
  );
  let url: URL | null = new URL(`${logPath}?order=desc&limit=100`, base);
  const visited = new Set<string>();
  const accounts = new Set<`0x${string}`>();
  while (url) {
    if (visited.has(url.href) || visited.size >= 100)
      throw new Error(
        "Borrower scan is incomplete. The mirror node pagination limit was reached.",
      );
    visited.add(url.href);
    const res = await fetch(url.href, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Mirror node request failed: ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.logs))
      throw new Error("The mirror node returned an invalid event response.");
    for (const log of json.logs) {
      const event: unknown = log?.topics?.[0];
      if (
        typeof event !== "string" ||
        event.replace(/^0x/, "").toLowerCase() !== borrowedSelector
      )
        continue;
      const topic: unknown = log?.topics?.[1];
      if (typeof topic === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(topic)) {
        accounts.add(`0x${topic.slice(-40).toLowerCase()}`);
      }
    }
    const next: unknown = json.links?.next;
    if (next !== null && next !== undefined && typeof next !== "string")
      throw new Error("Invalid mirror node pagination link.");
    url = next ? new URL(next as string, base) : null;
    if (
      url &&
      (url.origin !== base.origin ||
        url.pathname.toLowerCase() !== logPath.toLowerCase())
    ) {
      throw new Error("Unexpected mirror node pagination destination.");
    }
  }
  return [...accounts];
}
