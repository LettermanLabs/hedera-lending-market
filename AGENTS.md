# AGENTS.md — AI-assisted development guide

This repo is a **scaffold-hbar external template**: a full lending market dapp on Hedera
testnet. Read this before changing code.

## What this repo is

- `packages/hardhat` — Solidity (`LendingPool.sol` + mocks), Hardhat tests, and the
  deploy pipeline (HTS token creation, HCS topic, SaucerSwap seeding).
- `packages/nextjs` — Next.js 15 app (App Router) with wagmi 2 + RainbowKit, Tailwind 4.
- `template.json` — the scaffold-hbar manifest. Keep it valid; it declares the rename
  placeholder `HederaLendingTemplate` (only used in the root `package.json` name) and the
  env vars the CLI writes into `.env.example`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Hardhat unit tests (17) — mocks for Pyth, SaucerSwap, WHBAR, USDX |
| `npm run compile` | Compile contracts |
| `npm run deploy` | Create HTS USDX, deploy pool, seed liquidity + faucet, create HCS topic |
| `npm run bootstrap` | Seed SaucerSwap V1 WHBAR/USDX pool (run after deploy) |
| `npm run associate` | Associate operator account with USDX + WHBAR |
| `npm run export-abis` | Regenerate `packages/nextjs/contracts/abis/` from artifacts |
| `npm run dev` / `build` / `lint` | Next.js dev server / production build / tsc + eslint |

## Hard rules

1. **Never commit `.env` or secrets.** The deployer key lives only in the repo-root
   `.env` (gitignored). The frontend gets `NEXT_PUBLIC_*` values via
   `packages/nextjs/.env.local`, also gitignored.
2. **Testnet only.** Contracts are wired to Hedera testnet constants in
   `packages/hardhat/scripts/lib/config.ts`. Verify addresses against
   [SaucerSwap deployments](https://docs.saucerswap.finance/developers/contracts) and
   [Pyth EVM addresses](https://docs.pyth.network/price-feeds/core/contract-addresses/evm)
   before changing them.
3. **Decimals discipline**: HBAR/WHBAR = 8, USDX = 6, USD values in the pool = 18.
   Pyth prices carry their own exponent — normalize via `10 ** (18 + expo)`.
4. **Collateral is native HBAR**, custodied by the pool — never wrapped client-side.
   The SaucerSwap leg uses the router's *payable ETH* entry point (`swapExactETHForTokens`),
   path `[WHBAR, USDX]`; the router wraps HBAR itself. EVM value units are wei
   (1 HBAR = 1e18 wei); the Hashio relay rejects non-zero value below 1e10 wei (1 tinybar).
5. **The pull-oracle pattern is load-bearing**: any entry point that reads a price takes
   `bytes[] priceUpdateData` + forwards `getUpdateFee` as msg.value, then calls
   `getPriceNoOlderThan(id, 120s)`. Never cache-and-trust beyond 120s.

## Conventions

- Solidity 0.8.24, OpenZeppelin 5 (Math.mulDiv, SafeERC20, ReentrancyGuard).
  Custom errors (`error InsufficientCollateral()` etc.) — use `if (!cond) revert Err();`
  (Solidity has no `require(cond, CustomError())` form).
- Interest accounting: scaled balances × global index (`supplyIndex`/`borrowIndex`,
  1e18 = 1.0). `accrue()` must run before any balance-affecting op.
- Frontend reads go through `lib/pool.ts` (`usePoolRead`) — all reads are disabled until
  `NEXT_PUBLIC_LENDING_POOL` exists, so the app must boot unconfigured.
- After changing contract ABIs, run `npm run compile && npm run export-abis`.
- Env access: `lib/config.ts` (client) / `process.env` directly in the API route (server).

## Integration points you must not break

| File | Integration |
| --- | --- |
| `contracts/LendingPool.sol` → `updatePrice` | Pyth pull oracle (HBAR/USD) |
| `contracts/LendingPool.sol` → `liquidate` | SaucerSwap V1 router (`swapExactETHForTokens`, payable ETH leg) |
| `contracts/LendingPool.sol` → `associateTokens` | HTS precompile `0x167` |
| `scripts/deploy.ts` | HTS `TokenCreateTransaction`, HCS `TopicCreateTransaction` |
| `app/api/activity/route.ts` | HCS `TopicMessageSubmitTransaction` (server-side operator) |
| `components/LiquidationWatch.tsx`, `lib/mirror.ts` | Mirror node REST (event scan, topic feed) |

## Testing guidance

- Unit tests mock all ecosystem contracts (`contracts/mocks/`). Keep liquidation tests
  assertive about the exact seizure math (`repay × 1.05 ÷ price`, capped at collateral).
- The mock SaucerSwap router is fixed-rate and needs a USDX float — see the fixture in
  `test/LendingPool.ts`.
- Before submitting changes: `npm test && npm run lint && npm run build` must all pass,
  and `./self-check.sh` should stay green.
