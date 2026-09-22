# Hedera Lending Market (scaffold-hbar template)

**Created and maintained by LettermanLabs.** This is the
[canonical repository](https://github.com/LettermanLabs/hedera-lending-market)
for our Scaffold-HBAR Template Bounty project. Watch the
[interactive walkthrough](https://lettermanlabs.com/Hedera/) and see
[authorship and source provenance](PROVENANCE.md) for the dated development record.

Reuse and forks are welcome under the [MIT license](LICENSE); retain the applicable
copyright and license notices. If you enter a derivative in a competition, please
credit this upstream project and distinguish your own contributions. Eligibility
is determined by the competition organizers. Third-party components retain their
own licenses and attribution.

A collateralized lending market on Hedera. Suppliers deposit an HTS stable asset
(USDX) and earn interest; borrowers lock native HBAR as collateral and borrow USDX
against it. Borrowing power, withdrawals and liquidations are priced by the Pyth pull
oracle, and liquidations settle by seizing collateral and swapping it back to USDX on
SaucerSwap V1. Market activity is mirrored to an HCS topic, so there is a public,
consensus-timestamped feed of everything that happens on the market.

Scaffold it with one command:

```bash
npm create scaffold-hbar@latest my-lending-market -- --template <your-org>/hedera-lending-market
```

External templates run from any public GitHub repo, so there is no PR into
scaffold-hbar to wait on. This repository is the template: `packages/hardhat` has the
contracts and deploy pipeline, `packages/nextjs` has the app.

## Why each integration matters

Each dependency does real work here. Take one out and the market breaks:

| Integration | Role | What breaks without it |
| --- | --- | --- |
| Pyth (pull oracle) | Every `borrow`, `withdrawCollateral` and `liquidate` submits a signed HBAR/USD price update from Hermes inside the transaction and enforces freshness (`getPriceNoOlderThan(120s)`). | No borrowing power and no liquidation trigger; the market cannot price risk. |
| SaucerSwap V1 (DEX) | `liquidate` seizes HBAR collateral and swaps it to USDX through the V1 router's payable ETH entry point in the same transaction; proceeds pay the liquidator. | No liquidation path, so underwater debt can never be settled. |
| HTS | USDX is a native HTS token created by the deploy script and used through its ERC-20 facade; the pool associates WHBAR/USDX (and the SaucerSwap LP token) via the `0x167` precompile. | No borrowable asset and no collateral custody. |
| HCS | The deploy script creates an activity topic; the Next.js API mirrors market events to it; the Activity page reads it back through the mirror node. | No auditable activity trail. |
| Mirror node | The Liquidation Watch page finds borrowers by scanning `Borrowed` events via the mirror node REST API. | The liquidation UI has no index of positions. |

Three Hedera services run in the same flow: HTS (token plus associations), HCS
(submit plus mirror-node subscribe) and EVM contracts (all accounting).

## Prerequisites

- Node 20.18.3 or later, npm 10+
- A funded Hedera testnet account (create one at the [Hedera Portal](https://portal.hedera.com) and use the faucet button there)
- Optional: a [WalletConnect/Reown](https://cloud.reown.com) project ID so HashPack can connect through RainbowKit. MetaMask works without it.

## Setup (about 5 minutes)

```bash
# 1. Fill in your testnet credentials at the repo ROOT (gitignored)
cp .env.example .env
#    HEDERA_ACCOUNT_ID=0.0.XXXXXX
#    HEDERA_PRIVATE_KEY=0x...

# 2. Deploy: creates the HTS USDX token, deploys the pool, seeds liquidity,
#    creates the HCS topic, and writes packages/nextjs/.env.local
npm run deploy

# 3. Seed the SaucerSwap WHBAR/USDX pool so liquidations have a swap route
npm run bootstrap

# 4. Run the app
npm run dev        # http://localhost:3000
```

Then, in the app (MetaMask or HashPack connected to Hedera Testnet, chain 296):

1. Click *Claim 250 USDX* on the faucet (first time only: associate the token, see below).
2. Supply USDX to the pool to start earning interest.
3. Deposit HBAR collateral, then borrow USDX. A Pyth price update is pulled into the borrow transaction automatically.
4. Watch your health factor. Below 1.00, the position shows up in *Liquidation watch* and anyone can settle it.
5. Open the *Activity (HCS)* page for the consensus-timestamped event feed.

### Token association (one time, per wallet)

USDX is an HTS token, so a wallet has to associate it before it can receive any.
Two ways:

- HashPack: account menu, *Associate token to account*, paste the USDX token id
  printed by `npm run deploy` (also in `packages/hardhat/deployments/hedera-testnet.json`).
- CLI: put the wallet's credentials in `.env` and run `npm run associate`.

This is normal Hedera DeFi UX rather than a quirk of the template; the deploy README
walks through the full HTS lifecycle on purpose.

## Architecture

```
                 ┌─────────────────────────────── Hedera Testnet ───────────────────────────────┐
                 │                                                                               │
  User (Next.js) │   LendingPool (EVM)                                                           │
  ──────────────►│  ┌──────────────────────────────────────────┐                                 │
   borrow()      │  │ · accrue() interest (utilization-based)  │                                 │
   + Pyth update │  │ · borrow / repay / supply / withdraw     │        Pyth contract           │
                 │  │ · collateral checks vs Pyth HBAR/USD     │◄────── pull oracle ──────────► Hermes
   deposit() ───►│  │ · deposit: native HBAR custody           │        (0.0.3042133)           │
                 │  │ · liquidate: seize HBAR ─► SaucerSwap    │                                 │
                 │  │   V1 router (payable ETH) ─► USDX        │        SaucerSwap V1 router    │
                 │  │   ─► liquidator                          │        (0.0.19264)             │
                 │  └──────┬───────────────▲──────────────────┘                                 │
                 │         │ HTS 0x167     │ WHBAR path entry (0.0.15058)                        │
                 │    USDX (HTS, created by deploy)                                                  │
                 │                                                                               │
                 └───────────────────────────────────────────────────────────────────────────────┘
        Activity feed: market events ──► HCS topic (created by deploy) ──► mirror node REST ◄── Activity page
```

### Repository layout

```
├── template.json            # scaffold-hbar manifest (capabilities, rename map, env vars)
├── packages/
│   ├── hardhat/
│   │   ├── contracts/
│   │   │   ├── LendingPool.sol              # the market (accounting, risk, liquidation)
│   │   │   ├── interfaces/                  # IWHBAR, ISaucerSwapRouter, IHederaTokenService (0x167)
│   │   │   ├── mocks/                       # MockPyth / MockWHBAR / MockUSDX / MockSaucerSwapRouter
│   │   │   └── fork/                        # vendored SaucerSwap V1 AMM for the mainnet-fork test
│   │   ├── test/LendingPool.ts              # 17 unit tests (interest, liquidation math, faucet)
│   │   ├── test-fork/liquidation.fork.test.ts  # liquidation vs real WHBAR/USDC reserves (fork)
│   │   └── scripts/
│   │       ├── deploy.ts                    # HTS token + pool + HCS topic + env wiring
│   │       ├── bootstrap.ts                 # seeds the SaucerSwap WHBAR/USDX pool
│   │       ├── associate.ts                 # one-time token association helper
│   │       └── exportAbis.ts                # regenerates frontend ABIs
│   └── nextjs/
│       ├── app/                             # Market page, Activity page, /api/activity (HCS submit)
│       ├── components/                      # MarketStats, PositionPanel, LiquidationWatch, ...
│       ├── lib/                             # wagmi config, Hermes client, mirror node client
│       └── contracts/abis/                  # generated ABIs
├── AGENTS.md                                # guide for AI-assisted development
└── self-check.sh                            # eligibility-gate self check
```

## How the market works

- **Interest.** Utilization-based linear model: `borrow APY = 2% + 38% × utilization`.
  Interest accrues into a borrow index and a supply index (Compound-style scaled
  balances). 10% of interest goes to protocol reserves.
- **Risk.** Max LTV 75% (collateral factor), liquidation threshold 80%, 5% liquidation
  bonus. Health factor = (collateral value × 75%) / debt value; below 1.00 a position
  can be liquidated.
- **Liquidation.** Anyone calls `liquidate(borrower, repayAmount, minUsdxOut, deadline, priceUpdate)`:
  1. A fresh Pyth price proves the position is underwater.
  2. The liquidator's USDX repays part or all of the debt.
  3. Native HBAR collateral worth `repay × 1.05` is seized and swapped through
     SaucerSwap V1's payable ETH entry point (`swapExactETHForTokens`, path
     `[WHBAR, USDX]`; the router wraps HBAR itself). `minUsdxOut` protects against
     slippage and is quoted from the router first.
  4. Swap proceeds go to the liquidator. The profit is the bonus plus any gap between
     the oracle price and the pool price.

### Testnet addresses (verified against the mirror node)

| Contract | Hedera ID | EVM address |
| --- | --- | --- |
| Pyth oracle | `0.0.3042133` | `0xa2aa501b19aff244d90cc15a4cf739d2725b5729` |
| HBAR/USD feed id | — | `0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd` |
| SaucerSwap V1 router (legacy testnet, read-only) | `0.0.19264` | `0x0000000000000000000000000000000000004b40` |
| WHBAR (HTS facade, V1 swap path entry) | `0.0.15058` | `0x0000000000000000000000000000000000003ae2` |

Sources for these: the Pyth docs (EVM contract addresses page) and the SaucerSwap
contract deployments page, checked against `packages/hardhat/scripts/lib/config.ts`.

### Assumptions and simplifications

Read this before adapting the pool to anything real:

- USDX is treated as $1.00. The template deliberately uses one oracle feed; a
  production market would also value the debt asset from a Pyth USDC/USD feed.
- Simple interest (APY / seconds-per-year), not per-block compounding.
- Collateral earns no yield; it sits as native HBAR in the pool.
- LP tokens from `bootstrap` are sent to the pool contract and stay there (testnet
  convenience).
- If collateral runs out before debt is covered, the shortfall is absorbed by the pool
  (shared across suppliers).
- The faucet exists so testnet users can borrow without hunting for funds. Turn it off
  in production with `setFaucetEnabled(false)`.

## Development

```bash
npm install            # workspaces: hardhat + nextjs
npm test               # 17 unit tests against local mocks
npm run test:fork      # liquidation test vs real SaucerSwap mainnet reserves (fork)
npm run compile        # compile contracts
npm run export-abis    # regenerate packages/nextjs/contracts/abis (after contract changes)
npm run lint           # tsc (nextjs) + eslint
npm run build          # production build of the app
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `insufficient Pyth fee` / stale price | The app fetches a fresh update per transaction. If the cached price is older than 120s, click *Update price* on the market page first. |
| `faucet cooldown` | One claim per hour per account. |
| USDX transfer fails with an association error | Associate the token (see *Token association*). |
| HashPack does not appear in the wallet list | Set `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` (Reown Cloud) in `packages/nextjs/.env.local` and restart. |
| `npm run deploy` reverts at `associateTokens` | Wrong network in `.env`, or the precompile call ran out of gas. Check the chain and retry. |

## Evidence (Hedera testnet, deployer account 0.0.10653436)

- LendingPool contract: [0.0.10658737](https://hashscan.io/testnet/contract/0.0.10658737)
- USDX HTS token (created by `npm run deploy`): [0.0.10657747](https://hashscan.io/testnet/token/0.0.10657747)
- HCS activity topic: [0.0.10658821](https://hashscan.io/testnet/topic/0.0.10658821), with [message #1 read back through the mirror node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10658821/messages)
- Collateral deposit (native HBAR into pool custody): [0xe4b40b39f05ee40a4fa8ae1eed1c4a1470717e149f5d7d0defe7586a693f0660](https://hashscan.io/testnet/transaction/0xe4b40b39f05ee40a4fa8ae1eed1c4a1470717e149f5d7d0defe7586a693f0660)
- Pool token association (HTS precompile via HAPI): transactions on the [pool account](https://hashscan.io/testnet/account/0.0.10658737)
- Live SaucerSwap testnet quote through the legacy V1 router (read-only):
  `getAmountsOut(1 WHBAR → SAUCE) = 54.96 SAUCE` via router `0.0.19264`

### SaucerSwap testnet status

SaucerSwap's legacy testnet deployment cannot create new pairs anymore. The testnet
factory's pair contracts are no longer authorized to self-associate through the HTS
precompile, and SaucerSwap's canonical docs no longer list testnet contract tables.
`npm run bootstrap` detects the failure, explains it, and exits cleanly. On networks
where the factory works (mainnet V1 RouterV3 is `0.0.3045981`) the same script creates
and seeds the WHBAR/USDX pair end to end.

**Forked-mainnet evidence.** `npm run test:fork` forks Hedera mainnet with
`@hashgraph/system-contracts-forking` and settles a full liquidation against reserves
transferred on-fork from the real SaucerSwap WHBAR/USDC V1 pool (0.0.1462797, about
2.85M WHBAR / 268k USDC at the time of writing). The flow is supply, borrow, price
drop, then `liquidate` swaps the seized HBAR through the canonical SaucerSwap V1 AMM.
The AMM math is vendored verbatim from
[saucerswaplabs-core](https://github.com/saucerswaplabs/saucerswaplabs-core); only the
HTS-coupled token movement is adapted for the fork's emulation (see the headers in
`contracts/fork/`). The liquidator's profit is asserted against the AMM's
constant-product quote. This matches the bounty rule for protocols without a working
testnet deployment: a read-only or forked-mainnet integration.

### Hermes status

During the build window the public Hermes gateway (`hermes.pyth.network`) started
returning `401` on the signed-update endpoint after Pyth's August 2026 upgrade. That
affects every consumer of the public gateway, not just this template. The frontend
reads `NEXT_PUBLIC_HERMES_URL` (default: the public gateway), so a paid or self-hosted
Hermes instance drops in without code changes, and `bootstrap` falls back to CoinGecko
for the initial pool ratio when Hermes is unreachable. The on-chain Pyth side (pull
updates, `getPriceNoOlderThan` freshness checks, fee forwarding) is unaffected; it only
needs some source of signed updates.

## License

MIT, see [LICENSE](LICENSE).
