/**
 * Fire-and-forget reporter that mirrors on-chain activity to the HCS topic
 * through the server-side API route (which holds the operator key).
 */
export interface ActivityReport {
  type: string;
  account?: string;
  amount?: string;
  txHash?: string;
}

export async function reportActivity(report: ActivityReport): Promise<void> {
  try {
    await fetch("/api/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    // HCS mirroring is best-effort; never block the UX on it.
  }
}
