import {
  AccountId,
  Client,
  Hbar,
  NftId,
  PrivateKey,
  TokenCreateTransaction,
  TokenId,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";

/** Narrow seam over the Hedera SDK so tests run without a network. */
export interface HederaGateway {
  /** Create the deal-completion topic if HEDERA_DEAL_TOPIC_ID is not configured. */
  createDealTopic(): Promise<string>;
  /** Submit one message; returns mirror-checkable receipt facts. */
  submitDealMessage(
    topicId: string,
    payloadJson: string,
  ): Promise<{ transaction_id: string; sequence_number: number; consensus_timestamp: string }>;
}

export interface TitleTracker {
  /** First completed sale: mint an NFT whose metadata binds asset + record hash. */
  issueTitle(
    assetId: string,
    recordSha256: string,
  ): Promise<{ token_id: string; serial_number: number }>;
  /** Later resale: transfer the title NFT to the new owner. */
  transferTitle(tokenId: string, serialNumber: number, toAccountId: string): Promise<void>;
  /** Current NFT owner via mirror node; null if burned/unavailable. */
  ownerOf(tokenId: string, serialNumber: number): Promise<string | null>;
}

export interface OperatorConfig {
  network: "testnet" | "mainnet";
  accountId: string;
  privateKey: string;
  topicId?: string;
  /** Hard cap on the network transaction fee, in HBAR. */
  maxFeeHbar?: number;
}

export function loadOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const network = env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const accountId = env.HEDERA_ACCOUNT_ID;
  const privateKey = env.HEDERA_PRIVATE_KEY;
  if (!accountId || !privateKey)
    throw new Error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required");
  return {
    network,
    accountId,
    privateKey,
    topicId: env.HEDERA_DEAL_TOPIC_ID || undefined,
    maxFeeHbar: env.HEDERA_MAX_FEE_HBAR ? Number(env.HEDERA_MAX_FEE_HBAR) : 1,
  };
}

function parseKey(raw: string): PrivateKey {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return PrivateKey.fromStringECDSA(hex);
  return PrivateKey.fromStringDer(raw);
}

export class SdkHederaGateway implements HederaGateway {
  private readonly client: Client;
  private readonly key: PrivateKey;
  private readonly operatorId: AccountId;
  private readonly maxFee: Hbar;

  constructor(config: OperatorConfig) {
    this.client =
      config.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    this.key = parseKey(config.privateKey);
    this.operatorId = AccountId.fromString(config.accountId);
    this.client.setOperator(this.operatorId, this.key);
    this.maxFee = Hbar.fromString(String(config.maxFeeHbar ?? 1));
  }

  async createDealTopic(): Promise<string> {
    // Restricted topic: only the operator can submit, no custom fees, no
    // mutable fee-schedule key — the same fail-closed policy as the app.
    const tx = await new TopicCreateTransaction()
      .setTopicMemo("LettermanLabs deal completion ledger")
      .setSubmitKey(this.key.publicKey)
      .setAdminKey(this.key.publicKey)
      .setMaxTransactionFee(this.maxFee)
      .freezeWith(this.client)
      .sign(this.key);
    const receipt = await (await tx.execute(this.client)).getReceipt(this.client);
    return receipt.topicId!.toString();
  }

  async submitDealMessage(
    topicId: string,
    payloadJson: string,
  ): Promise<{ transaction_id: string; sequence_number: number; consensus_timestamp: string }> {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(payloadJson)
      .setMaxTransactionFee(this.maxFee)
      .freezeWith(this.client)
      .sign(this.key);
    const submitted = await tx.execute(this.client);
    const record = await submitted.getRecord(this.client);
    const receipt = await record.receipt;
    return {
      transaction_id: submitted.transactionId!.toString(),
      sequence_number: Number(receipt.topicSequenceNumber),
      consensus_timestamp: record.consensusTimestamp.toString(),
    };
  }

  close(): void {
    this.client.close();
  }
}

const TITLE_METADATA_MAX = 100;

export class SdkTitleTracker implements TitleTracker {
  private readonly client: Client;
  private readonly key: PrivateKey;
  private readonly operatorId: AccountId;
  private readonly mirrorBase: string;
  private readonly maxFee: Hbar;

  constructor(config: OperatorConfig) {
    this.client =
      config.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    this.key = parseKey(config.privateKey);
    this.operatorId = AccountId.fromString(config.accountId);
    this.client.setOperator(this.operatorId, this.key);
    this.mirrorBase =
      config.network === "mainnet"
        ? "https://mainnet-public.mirrornode.hedera.com"
        : "https://testnet.mirrornode.hedera.com";
    this.maxFee = Hbar.fromString(String(config.maxFeeHbar ?? 1));
  }

  async issueTitle(
    assetId: string,
    recordSha256: string,
  ): Promise<{ token_id: string; serial_number: number }> {
    const symbol = `LL${recordSha256.slice(0, 6).toUpperCase()}`;
    const create = await new TokenCreateTransaction()
      .setTokenName(`LettermanLabs deal title ${assetId}`.slice(0, 100))
      .setTokenSymbol(symbol)
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Finite)
      .setMaxSupply(1)
      .setTreasuryAccountId(this.operatorId)
      .setAdminKey(this.key.publicKey)
      .setSupplyKey(this.key.publicKey)
      .setMaxTransactionFee(this.maxFee)
      .freezeWith(this.client)
      .sign(this.key);
    const tokenReceipt = await (await create.execute(this.client)).getReceipt(this.client);
    const tokenId = tokenReceipt.tokenId!.toString();

    const metadata = Buffer.from(
      JSON.stringify({ v: 1, asset: assetId, record: recordSha256 }),
      "utf8",
    ).slice(0, TITLE_METADATA_MAX);
    const mint = await new TokenMintTransaction()
      .setTokenId(tokenId)
      .setMetadata([metadata])
      .setMaxTransactionFee(this.maxFee)
      .freezeWith(this.client)
      .sign(this.key);
    const mintReceipt = await (await mint.execute(this.client)).getReceipt(this.client);
    return { token_id: tokenId, serial_number: Number(mintReceipt.serials[0]) };
  }

  async transferTitle(tokenId: string, serialNumber: number, toAccountId: string): Promise<void> {
    const nft = new NftId(TokenId.fromString(tokenId), serialNumber);
    const transfer = await new TransferTransaction()
      .addNftTransfer(nft, this.operatorId, AccountId.fromString(toAccountId))
      .setMaxTransactionFee(this.maxFee)
      .freezeWith(this.client)
      .sign(this.key);
    await (await transfer.execute(this.client)).getReceipt(this.client);
  }

  async ownerOf(tokenId: string, serialNumber: number): Promise<string | null> {
    const res = await fetch(
      `${this.mirrorBase}/api/v1/tokens/${tokenId}/nfts/${serialNumber}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Mirror node returned ${res.status}`);
    const body = (await res.json()) as { account_id?: string };
    return body.account_id ?? null;
  }

  close(): void {
    this.client.close();
  }
}
