# Development notes

Hedera Lending Market is designed and built by [LettermanLabs](https://lettermanlabs.com).

This project targets **Hedera testnet**. Start with the README for setup and
integration status. Use these notes when changing contracts, scripts, or the app.

## Layout and commands

- `packages/hardhat`: Solidity, local/fork tests, deployment/bootstrap and ABI export.
- `packages/nextjs`: Next.js App Router, wagmi/RainbowKit, server price/HCS routes.
- `template.json`: scaffold CLI options, package renaming, environment variables,
  and setup instructions.

Use Node 22.14+ or 24 LTS and `npm` 10+. Root commands:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked workspace dependencies |
| `npm run compile` / `npm run export-abis` | Compile contracts, then refresh frontend ABIs |
| `npm run test` | Contract, app/server, and deployment helper tests |
| `npm run test:fork` | Network-dependent Hedera mainnet-fork liquidation and ecosystem checks |
| `npm run coverage` | Solidity coverage report for the contract tests |
| `npm run lint` / `npm run build` | Both workspace type/lint checks; production app build |
| `npm run check` | App validation (also works after CLI consumes the manifest) |
| `npm run check:template` / `./self-check.sh` | Strict template source validation; manifest required |
| `npm run audit:production` | Production dependency audit, high/critical gate |
| `npm run dev` | Local app, usable without deployment credentials |
| `npm run deploy` | Deploy to testnet; saves progress for retries |
| `npm run bootstrap` | Create and seed a testnet swap route |
| `npm run associate` | Associate the configured operator with USDX/WHBAR |

## Rules to preserve

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

## Before opening a pull request

After ABI changes, compile and export the updated ABIs. Add regression tests for
accounting, unit conversion, or receipt bugs, then run tests, lint, and build.
Check both configured and unconfigured pages in a browser.
Run the separate fork test for contract/integration changes when the RPC is available.

The fork liquidation test uses emulated mainnet HTS assets, a local constant-product
harness, and a mock oracle. The deployed SaucerSwap router is checked separately
with read-only calls. If you change LendingPool, test a fresh deployment; the old
testnet links refer to the previous bytecode.

Keep the GPL attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
its license copy. They apply to fixtures in earlier revisions.
