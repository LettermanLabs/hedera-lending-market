/** Read-only mirror node access for verification. Inject a fake in tests. */
export interface MirrorGateway {
  fetchTopicMessage(
    topicId: string,
    sequenceNumber: number,
  ): Promise<{ consensusTimestamp: string; message: string }>;
}

export class HttpMirrorGateway implements MirrorGateway {
  constructor(private readonly baseUrl: string) {}

  static forNetwork(network: "testnet" | "mainnet"): HttpMirrorGateway {
    return new HttpMirrorGateway(
      network === "mainnet"
        ? "https://mainnet-public.mirrornode.hedera.com"
        : "https://testnet.mirrornode.hedera.com",
    );
  }

  async fetchTopicMessage(
    topicId: string,
    sequenceNumber: number,
  ): Promise<{ consensusTimestamp: string; message: string }> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/topics/${topicId}/messages?sequenceNumber=${sequenceNumber}`,
    );
    if (res.status === 404) throw new Error(`No message ${sequenceNumber} on topic ${topicId}`);
    if (!res.ok) throw new Error(`Mirror node returned ${res.status}`);
    const body = (await res.json()) as { messages?: { consensus_timestamp: string; message: string }[] };
    const msg = body.messages?.[0];
    if (!msg) throw new Error(`Mirror node returned no message for sequence ${sequenceNumber}`);
    // Mirror returns message as base64.
    return {
      consensusTimestamp: msg.consensus_timestamp,
      message: Buffer.from(msg.message, "base64").toString("utf8"),
    };
  }
}
