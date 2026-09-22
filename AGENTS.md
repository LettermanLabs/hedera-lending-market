# Agent guide

This is a scaffold-hbar external lending template for **Hedera testnet**. Read the
README for setup, required API access and limits of the local fork-harness evidence.

## Layout and commands

- `packages/hardhat`: Solidity, local/fork tests, deployment/bootstrap and ABI export.
- `packages/nextjs`: Next.js App Router, wagmi/RainbowKit, server price/HCS routes.
- `template.json`: current scaffold CLI manifest with npm-only capabilities,
  directory-based rename map, env descriptions and `outro.sections`.

Use Node 22.14+ or 24 LTS and `npm` 10+. Root commands:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked workspace dependencies |
| `npm run compile` / `npm run export-abis` | Compile contracts, then refresh frontend ABIs |
| `npm run test` | Contract, app/server, and tooling regression tests |
| `npm run test:fork` | Network-dependent Hedera mainnet-fork liquidation and ecosystem checks |
| `npm run lint` / `npm run build` | Both workspace type/lint checks; production app build |
| `npm run check` | App validation (also works after CLI consumes the manifest) |
| `npm run check:template` / `./self-check.sh` | Strict template source validation; manifest required |
| `npm run audit:production` | Production dependency audit, high/critical gate |
| `npm run dev` | Local app, usable without deployment credentials |
| `npm run deploy` | Paid testnet deployment; resumable progress journal |
| `npm run bootstrap` | Paid attempt to create/seed a testnet swap route |
| `npm run associate` | Associate the configured operator with USDX/WHBAR |

## Invariants

1. Never commit secrets, `.env`, `.env.local`, deployment records or server journals.
   Deploy reads root `.env`; Next.js server credentials are configured separately in
   `packages/nextjs/.env.local`. Secrets never use `NEXT_PUBLIC_`.
2. HBAR/WHBAR contract quantities and contract-side `msg.value` are **8 decimals**.
   Wallet/ethers JSON-RPC `value` is **18 decimals** (tinybars × 1e10). USDX is **6**;
   USD prices and indexes are **18**. Convert only at the transaction boundary.
3. Every balance-changing action accrues interest before checking account health.
   Borrowing limits use 75% LTV; liquidations/health factor use the 80% threshold.
   Use conservative rounding, preserve aggregate scaled-share invariants and clear
   residual shares on full repayments. Supplier losses must not create future claims.
4. Oracle-sensitive writes forward the tinybar Pyth update fee and enforce freshness.
   The server proxy returns signed updates from authorized Hermes access; never substitute
   fabricated prices. Client config uses direct `process.env.NEXT_PUBLIC_*` references.
5. HCS messages come from confirmed pool receipt events, not caller-supplied amounts or
   identities. Preserve submit-key restriction, persistent deduplication, paid-budget
   limits, and fail-closed handling of uncertain submissions. HCS is optional best effort.
6. Scripts are testnet-only. Never infer successful pair creation from a caught error.
   LP token association uses `pair.lpToken()`, not the pair address. Failed/uncertain
   journal steps require reconciliation; completed seeds must not run twice. Preserve
   custom environment entries when updating generated addresses.

## Change validation

After ABI changes run compile + export. Unit tests mock integrations; add regressions
for accounting/unit/receipt bugs, then run tests, lint and build. Check configured and
unconfigured pages in a real browser because a successful build does not prove boot.
Run the separate fork test for contract/integration changes when the RPC is available.

Keep claims precise: the fork liquidation test uses mainnet HTS asset emulation,
a locally deployed MIT constant-product harness with seeded reserves, and a mock
oracle. That liquidation is not executed through the deployed SaucerSwap router.
Any read-only deployed-contract check is separate evidence. Preserve the historical
GPL attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and its license
copy; replacing fixtures does not relicense older revisions. Historical testnet links
do not validate a newly changed LendingPool contract.
