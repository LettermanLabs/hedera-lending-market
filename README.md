# Hedera Lending Market — scaffold-hbar template

A collateralized lending market on Hedera. Suppliers deposit an HTS stable asset
(**USDX**) to earn interest; borrowers lock **HBAR** collateral to borrow USDX against it.
Borrowing power, withdrawals and liquidations are priced by the **Pyth pull oracle**;
underwater positions are settled by seizing collateral and swapping it back to USDX on
**SaucerSwap V1**; every market action is mirrored to an **HCS** topic for an auditable,
consensus-timestamped activity feed.

Scaffold it in one command:

```bash
npm create scaffold-hbar@latest my-lending-market -- --template <your-org>/hedera-lending-market
```

> External templates run from any public GitHub repo — no PR into scaffold-hbar needed.
> This repository *is* the template: `packages/hardhat` holds the contracts and deploy
> pipeline, `packages/nextjs` the app.

---

## Why the integrations are load-bearing

This template is not a demo that *mentions* protocols — remove any one of them and the
market stops working:

| Integration | Role | What breaks without it |
| --- | --- | --- |
| **Pyth** (pull oracle) | Every `borrow`, `withdrawCollateral` and `liquidate` submits a signed HBAR/USD price update from Hermes inside the transaction and enforces freshness (`getPriceNoOlderThan(120s)`). | No borrowing power, no liquidation trigger — the market cannot price risk. |
| **SaucerSwap V1** (DEX) | `liquidate` seizes HBAR collateral and swaps it to USDX through the SaucerSwap V1 router's payable ETH entry point in the same transaction; proceeds pay the liquidator. | No liquidation path — underwater debt can never be settled. |
| **HTS** | USDX is a native HTS token created by the deploy script and used through its ERC-20 facade; the pool self-associates WHBAR/USDX (and the SaucerSwap LP token) via the `0x167` precompile. | No borrowable asset, no collateral wrapping. |
| **HCS** | The deploy script creates an activity topic; the Next.js API mirrors market events to it; the Activity page reads it back through the mirror node. | No auditable off-chain activity trail. |
| **Mirror node** | The Liquidation Watch page finds borrowers by scanning `Borrowed` events from the mirror node REST API. | The liquidation UI has no index of positions. |

Hedera services are also composed with real depth: **HTS** (token + associations),
**HCS** (submit + mirror-node subscribe), and **EVM smart contracts** (all accounting)
working together in one flow.

---

## Prerequisites

- Node **20.18.3** or later, npm 10+
- A funded **Hedera testnet account** — create one at the
  [Hedera Portal](https://portal.hedera.com) and fund it from the faucet button there
- Optional: a [WalletConnect/Reown](https://cloud.reown.com) project ID so HashPack can
  connect through RainbowKit (MetaMask works without it)

## Setup (5 minutes)

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

Then, in the app (with MetaMask or HashPack connected to Hedera Testnet, chain 296):

1. **Get USDX** — click *Claim 250 USDX* (first time: associate the token — see below).
2. **Supply** USDX to the pool → you earn interest.
3. **Deposit** HBAR collateral, then **Borrow** USDX (a Pyth price update is pulled into the transaction automatically).
4. Watch your **health factor**; when it drops below 1.00 your position appears in
   *Liquidation watch* and anyone can settle it.
5. Open the **Activity (HCS)** page to see the consensus-timestamped event feed.

### Token association (one-time, per wallet)

USDX is an HTS token, so a wallet must *associate* it before receiving any. Options:

- **HashPack**: click the account menu → *Associate token to account* → paste the USDX
  token id printed by `npm run deploy` (also in `packages/hardhat/deployments/hedera-testnet.json`).
- **CLI**: put the wallet's credentials in `.env` and run `npm run associate`.

This mirrors production Hedera DeFi UX and is intentional — the template shows you the
full HTS lifecycle, association included.

## Architecture

```
                 ┌─────────────────────────────── Hedera Testnet ───────────────────────────────┐
                 │                                                                               │
  User (Next.js) │   LendingPool (EVM)                                                           │
  ──────────────►│  ┌──────────────────────────────────────────┐                                 │
   borrow()      │  │ · accrue() interest (utilization-based)  │                                 │
   + Pyth update │  │ · borrow / repay / supply / withdraw     │        Pyth contract           │
                 │  │ · collateral checks vs Pyth HBAR/USD     │◄────── pull oracle ──────────► Hermes
   deposit() ───►│  │ · deposit: wraps HBAR ► SaucerSwap WHBAR │        (0.0.3042133)           │
                 │  │ · liquidate: seize WHBAR ─► SaucerSwap   │                                 │
                 │  │   V1 router ─► USDX ─► liquidator        │        SaucerSwap V1 router    │
                 │  └──────┬───────────────▲──────────────────┘        (0.0.19264)             │
                 │         │ HTS 0x167     │ WHBAR (0.0.15058)                                       │
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
│   │   │   └── mocks/                       # MockPyth / MockWHBAR / MockUSDX / MockSaucerSwapRouter
│   │   ├── test/LendingPool.ts              # 17 unit tests (interest, liquidation math, faucet)
│   │   └── scripts/
│   │       ├── deploy.ts                    # HTS token + pool + HCS topic + env wiring
│   │       ├── bootstrap.ts                 # seeds the SaucerSwap WHBAR/USDX pool
│   │       ├── associate.ts                 # one-time token association helper
│   │       └── exportAbis.ts                # regenerates frontend ABIs
│   └── nextjs/
│       ├── app/                             # Market page, Activity page, /api/activity (HCS submit)
│       ├── components/                      # MarketStats, PositionPanel, LiquidationWatch, …
│       ├── lib/                             # wagmi config, Hermes client, mirror node client
│       └── contracts/abis/                  # generated ABIs
├── AGENTS.md                                # development guide
└── self-check.sh                            # eligibility-gate self check
```

## How the market works

- **Interest** — utilization-based linear model: `borrow APY = 2% + 38% × utilization`.
  Interest accrues into a borrow index and a supply index ( Compound-style scaled
  balances ); 10% of interest goes to protocol reserves.
- **Risk** — max LTV 75% (collateral factor), liquidation threshold 80%, 5% liquidation
  bonus. Health factor = (collateral value × 75%) ÷ debt value; below 1.00 = liquidatable.
- **Liquidation** — anyone calls `liquidate(borrower, repayAmount, minUsdxOut, deadline, priceUpdate)`:
  1. a fresh Pyth price proves the position is underwater;
  2. the liquidator's USDX repays part (or all) of the debt;
  3. native HBAR collateral worth `repay × 1.05` is seized and swapped through SaucerSwap
     V1's payable ETH entry point (`swapExactETHForTokens`, path `[WHBAR, USDX]` — the
     router wraps HBAR itself), slippage-protected via `minUsdxOut` and quoted from the
     router first;
  4. swap proceeds go to the liquidator — their profit is the bonus plus any gap between
     the oracle price and the pool price.

### Testnet addresses (verified)

| Contract | Hedera ID | EVM address |
| --- | --- | --- |
| Pyth oracle | `0.0.3042133` | `0xa2aa501b19aff244d90cc15a4cf739d2725b5729` |
| HBAR/USD feed id | — | `0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd` |
| SaucerSwap V1 router (legacy testnet, read-only) | `0.0.19264` | `0x0000000000000000000000000000000000004b40` |
| WHBAR (HTS facade used as the V1 swap path entry) | `0.0.15058` | `0x0000000000000000000000000000000000003ae2` |

The Pyth address/feed and SaucerSwap addresses are also fetched from official sources at
build-review time — see `packages/hardhat/scripts/lib/config.ts`.

### Assumptions & simplifications (read before shipping anything real)

- **USDX is treated as $1.00.** The template intentionally uses one oracle feed; a
  production market would value the debt asset with a Pyth USDC/USD feed too.
- **Simple interest** (APY ÷ seconds-per-year), not per-block compounding.
- **Collateral earns no yield** (held as native HBAR in the pool).
- **Liquidation LP tokens are locked** in the pool contract (testnet convenience —
  `bootstrap.ts` sends them to the pool).
- **Residual bad debt is socialized** across suppliers if collateral is exhausted.
- The faucet exists purely so testnet users can borrow without a faucet dependency —
  disable it in production (`setFaucetEnabled(false)`).

## Development

```bash
npm install            # workspaces: hardhat + nextjs
npm test               # 17 unit tests against local mocks
npm run compile        # compile contracts
npm run export-abis    # regenerate packages/nextjs/contracts/abis (after contract changes)
npm run lint           # tsc (nextjs) + eslint
npm run build          # production build of the app
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `insufficient Pyth fee` / stale price | The app fetches a fresh update per transaction; if the cached price is >120s old, click *Update price* on the market page first. |
| `faucet cooldown` | One claim per hour per account. |
| Transfer of USDX fails with an association error | Associate the token (see *Token association*). |
| HashPack doesn't appear in the wallet list | Set `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` (Reown Cloud) in `packages/nextjs/.env.local` and restart. |
| `npm run deploy` reverts at `associateTokens` | The pool was deployed to the wrong network or the precompile call ran out of gas — check `.env` chain and retry. |

## Evidence (Hedera testnet, deployer account 0.0.10653436)

- **LendingPool contract**: [0.0.10658737](https://hashscan.io/testnet/contract/0.0.10658737)
- **USDX HTS token** (created by `npm run deploy`): [0.0.10657747](https://hashscan.io/testnet/token/0.0.10657747)
- **HCS activity topic**: [0.0.10658821](https://hashscan.io/testnet/topic/0.0.10658821) — [message #1 mirrored back through the mirror node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10658821/messages)
- **Collateral deposit** (native HBAR → pool custody): [0xe4b40b39…](https://hashscan.io/testnet/transaction/0xe4b40b39f05ee40a4fa8ae1eed1c4a1470717e149f5d7d0defe7586a693f0660)
- **Pool token association** (HTS precompile via HAPI): see transactions on the [pool account](https://hashscan.io/testnet/account/0.0.10658737)
- **Live SaucerSwap testnet quote** through the legacy V1 router (read-only):
  `getAmountsOut(1 WHBAR → SAUCE) = 54.96 SAUCE` via router `0.0.19264`

### SaucerSwap testnet status (verified during the build window)

SaucerSwap's **legacy testnet deployment can no longer create new pairs**: the
testnet factory's pair contracts are no longer authorized to self-associate via the HTS
precompile, and SaucerSwap's canonical docs no longer publish testnet contract tables.
`npm run bootstrap` detects this, prints an explanation, and exits cleanly; on networks
where the factory is functional (mainnet: V1 RouterV3 `0.0.3045981`) the same script
creates and seeds the WHBAR/USDX pair automatically. Per the bounty brief, a read-only
testnet integration (live router quotes) plus the unit-tested swap path is the fallback
— a forked-mainnet liquidation test against SaucerSwap's real WHBAR/USDC liquidity is the
planned strengthening of this evidence.

### Hermes status

During the build window the public Hermes gateway (`hermes.pyth.network`) began
returning `401` on the signed-update endpoint (following Pyth's August 2026 upgrade) —
this affects every consumer, not just this template. The frontend reads
`NEXT_PUBLIC_HERMES_URL` (defaults to the public gateway) so a paid/self-hosted Hermes
instance can be dropped in without code changes; `bootstrap` falls back to CoinGecko for
the initial pool ratio if Hermes is unreachable. The on-chain Pyth integration (pull
updates, `getPriceNoOlderThan` freshness, fee forwarding) is unaffected — it only needs
*some* source of signed updates.

## License

MIT — see [LICENSE](LICENSE).
