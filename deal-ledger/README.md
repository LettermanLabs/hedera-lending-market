# Deal Ledger — Hedera markers for completed deals

Immutable, independently verifiable completion records for deals that close on
LettermanLabs. Hedera Consensus Service is the ledgered marker; HTS title NFTs
are optional transferable title. HBAR is only the fee token — never the
ownership marker.

## What goes on-chain vs off-chain

The full deal record (description, documents, parties, price if retained)
**never** goes on-chain. It lives in the workspace database
(`db/schema.sql`). On Hedera, one small JSON message per completed deal:

```json
{
  "v": 1,
  "kind": "lettermanlabs_deal_completion",
  "deal": "sha256:…", "asset": "sha256:…", "buyer": "sha256:…", "seller": "sha256:…",
  "record": "<sha256 of the canonical off-chain record>",
  "status": "completed",
  "completed_at": "2026-10-03T15:00:00Z",
  "price": { "amount": "12750000.00", "currency": "USD" }
}
```

- `price` is **omitted entirely** unless the parties opted to disclose it —
  never `null`, never a placeholder.
- IDs are `sha256:<salted digest>` by default. Unsalted hashing of
  low-entropy IDs (emails, short refs) is reversible, so the salt
  (`HEDERA_ID_HASH_SALT`) stays server-side. `DEAL_DEMO_DISCLOSE_IDS=1` is the
  explicit opt-in to plain IDs.
- Anyone holding the off-chain record can recompute `record` and compare it
  with the topic message — that binding is the fraud signal.

## Data model

`db/schema.sql` — `deal_ledger_entries` with the canonical record, receipt
facts, optional title token, RLS for workspace reads, and the double-sale
guard: a partial unique index allowing **at most one `completed` row per
asset**. Resales mark the prior row `resold` (or record a new sequenced
message linking the prior receipt) — never a silent overwrite.

## Service functions

- `DealLedger.completeDeal(input)` — double-sale guard → build canonical
  record → hash → persist pending → submit HCS message (operator signs/pays,
  max 1 HBAR fee) → optional title mint/transfer → persist receipt.
- `DealLedger.verifyDeal(dealId)` — recompute the record hash, fetch the exact
  topic message from a mirror node, report match/mismatch with reasons.
- `DealLedger.assetStatus(assetId)` — pre-completion check for the UI:
  completed? which deal? who owns the title NFT?

## Fraud limits (by design)

- Covers only deals that close **through LettermanLabs** and are checked
  against this ledger. An off-platform sale is invisible.
- A completion message alone does not move ownership. Resales must transfer
  the HTS title NFT (or write a new sequenced HCS message explicitly).
- Public topics are readable by anyone — that is why IDs are salted hashes and
  price is omitted by default.
- Garbage in, garbage out: the marker proves a version existed at consensus
  time, not that its description is true.

## Testnet steps

```bash
cp .env.example .env.local          # fill HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY (testnet operator)
npm run deal-ledger:bootstrap       # 1. create the restricted topic → prints HEDERA_DEAL_TOPIC_ID
# → add HEDERA_DEAL_TOPIC_ID=0.0.… to .env.local

npm run deal-ledger:first-marker    # 2. record a demo deal; writes .data/deal-public-receipt.json
DEAL_DEMO_PRICE=12750000.00 npm run deal-ledger:first-marker   # variant with disclosed price

npm run deal-ledger:verify -- deal-…  # 3. recompute + mirror-node check
```

Optional env: `ENABLE_TITLE_NFT=1` (mint/transfer HTS title NFTs),
`HEDERA_ID_HASH_SALT` (stable across restarts, server-side only),
`HEDERA_NETWORK=testnet` (default), `HEDERA_MAX_FEE_HBAR=1` (default).

The SDK is `@hiero-ledger/sdk` — the current name of the package the spec
calls `@hashgraph/sdk`.

## Production wiring

`HttpMirrorGateway` and the SDK gateways are network-bound; the `DealLedger`
class takes them as injected dependencies, so the completion flow is unit
tested without a network (`npm run test:ledger`). In the app, implement
`LedgerStorage` over `deal_ledger_entries` (service role) and call
`completeDeal` from the deal-completion transition, `assetStatus` before
allowing a new completion, and `verifyDeal` from the receipt view.
