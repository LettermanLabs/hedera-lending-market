# AGENTS.md — AI-assisted development guide

This repo is a scaffold-hbar external template: a lending market dapp on Hedera
testnet. Read this before changing code.

## What this repo is

- `packages/hardhat`: Solidity (`LendingPool.sol` + mocks), Hardhat tests, and the
  deploy pipeline (HTS token creation, HCS topic, SaucerSwap seeding).
- `packages/nextjs`: Next.js 15 app (App Router) with wagmi 2 + RainbowKit, Tailwind 4.
- `template.json`: the scaffold-hbar manifest. Keep it valid. It declares the rename
  placeholder `HederaLendingTemplate` (only used in the root `package.json` name) and
  the env vars the CLI writes into `.env.example`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Hardhat unit tests (17), with mocks for Pyth, SaucerSwap, WHBAR, USDX |
| `npm run compile` | Compile contracts |
| `npm run deploy` | Create HTS USDX, deploy pool, seed liquidity + faucet, create HCS topic |
| `npm run bootstrap` | Seed the SaucerSwap V1 WHBAR/USDX pool (run after deploy) |
| `npm run associate` | Associate the operator account with USDX + WHBAR |
| `npm run export-abis` | Regenerate `packages/nextjs/contracts/abis/` from artifacts |
| `npm run dev` / `build` / `lint` | Next.js dev server / production build / tsc + eslint |

## Hard rules

1. Never commit `.env` or secrets. The deployer key lives only in the repo-root
   `.env` (gitignored). The frontend gets `NEXT_PUBLIC_*` values via
   `packages/nextjs/.env.local`, also gitignored.
2. Testnet only. Contracts are wired to Hedera testnet constants in
   `packages/hardhat/scripts/lib/config.ts`. Verify addresses against the
   [SaucerSwap deployments](https://docs.saucerswap.finance/developers/contracts) and
   [Pyth EVM addresses](https://docs.pyth.network/price-feeds/core/contract-addresses/evm)
   before changing them.
3. Decimals: HBAR/WHBAR = 8, USDX = 6, USD values in the pool = 18. Pyth prices carry
   their own exponent; normalize via `10 ** (18 + expo)`.
4. Collateral is native HBAR, custodied by the pool. It is never wrapped client-side.
   The SaucerSwap leg uses the router's payable ETH entry point
   (`swapExactETHForTokens`) with path `[WHBAR, USDX]`; the router wraps HBAR itself.
   EVM value units are wei (1 HBAR = 1e18 wei), and the Hashio relay rejects non-zero
   value below 1e10 wei (1 tinybar).
5. The pull-oracle pattern is not optional: every entry point that reads a price takes
   `bytes[] priceUpdateData`, forwards `getUpdateFee` as msg.value, then calls
   `getPriceNoOlderThan(id, 120s)`. Do not cache-and-trust beyond 120s.

## Conventions

- Solidity 0.8.24, OpenZeppelin 5 (Math.mulDiv, SafeERC20, ReentrancyGuard). Custom
  errors (`error InsufficientCollateral()` etc.) use `if (!cond) revert Err();` since
  Solidity has no `require(cond, CustomError())` form.
- Interest accounting: scaled balances times a global index (`supplyIndex` /
  `borrowIndex`, 1e18 = 1.0). `accrue()` must run before any balance-affecting op.
- Frontend reads go through `lib/pool.ts` (`usePoolRead`); reads stay disabled until
  `NEXT_PUBLIC_LENDING_POOL` exists, so the app must boot unconfigured.
- After changing contract ABIs, run `npm run compile && npm run export-abis`.
- Env access: `lib/config.ts` (client), `process.env` directly in the API route (server).

## Integration points not to break

| File | Integration |
| --- | --- |
| `contracts/LendingPool.sol` → `updatePrice` | Pyth pull oracle (HBAR/USD) |
| `contracts/LendingPool.sol` → `liquidate` | SaucerSwap V1 router (`swapExactETHForTokens`, payable ETH leg) |
| `contracts/fork/*` + `test-fork/` | Vendored SaucerSwap V1 AMM (verbatim math) for the mainnet-fork liquidation test (`npm run test:fork`); only HTS-coupled parts adapted, see file headers |
| `contracts/LendingPool.sol` → `associateTokens` | HTS precompile `0x167` |
| `scripts/deploy.ts` | HTS `TokenCreateTransaction`, HCS `TopicCreateTransaction` |
| `app/api/activity/route.ts` | HCS `TopicMessageSubmitTransaction` (server-side operator) |
| `components/LiquidationWatch.tsx`, `lib/mirror.ts` | Mirror node REST (event scan, topic feed) |

## Testing

- Unit tests mock all ecosystem contracts (`contracts/mocks/`). The liquidation tests
  assert the exact seizure math (`repay × 1.05 / price`, capped at collateral); keep
  them that precise.
- The mock SaucerSwap router is fixed-rate and needs a USDX float; see the fixture in
  `test/LendingPool.ts`.
- Before submitting changes, `npm test && npm run lint && npm run build` must pass,
  `npm run test:fork` must pass against Hedera mainnet, and `./self-check.sh` should
  stay green. Fork tests need network access to `mainnet.hashio.io` and the mirror node.
