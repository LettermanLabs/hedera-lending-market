import type { Hash } from "viem";

/** The server derives event contents from the confirmed receipt, never caller labels. */
export async function reportActivity(txHash: Hash): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return null;
      if (response.status === 409 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      return "Your transaction is confirmed. Its HCS activity entry is unavailable; the HashScan receipt remains the source of truth.";
    } catch {
      return "Your transaction is confirmed. HCS mirroring could not be confirmed; check the activity feed later.";
    }
  }
  return null;
}
