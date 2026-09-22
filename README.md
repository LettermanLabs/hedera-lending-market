# Hedera Lending Market

A scaffold-hbar lending template for Hedera testnet. Supply six-decimal HTS USDX,
lock native HBAR, borrow against Pyth HBAR/USD, and liquidate through a SaucerSwap
V1 route. The optional HCS feed records verified pool events with consensus timestamps.

The app boots without credentials. Executing loans needs a deployed pool, an
associated wallet, testnet funds and an authorized Hermes price service. Live
liquidation additionally needs a seeded swap route; see the testnet limitation below.

## Run locally

Use **Node.js 22.14+ or 24 LTS** and `npm` 10+. From a public version of this repository:

```bash
npx create-scaffold-hbar@latest my-lending-market --template LettermanLabs/hedera-lending-market --network testnet --skip-hedera-skills
cd my-lending-market
npm run dev
```

For an authenticated clone, run `npm ci` first. Open [localhost:3000](http://localhost:3000).
The unconfigured market and Activity pages explain what is needed; reading the UI
does not require an operator private key. A private GitHub repository cannot be used
by an unauthenticated public-template evaluator.

## Configure and deploy to testnet

1. Create and fund an **ECDSA Hedera testnet account** using the
   [Hedera Portal](https://portal.hedera.com). Copy the root `.env.example` to `.env`
   and fill in `HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY`.
2. Configure `HERMES_URL` / `PYTH_API_KEY` for bootstrap. The Pyth gateway now
   requires API authorization; see [Pyth's upgrade guide](https://docs.pyth.network/price-feeds/core/upgrade/preparing).
3. Run `npm run deploy`. This spends testnet HBAR to create USDX, deploy the pool,
   associate tokens, seed borrow liquidity/faucet, and create a topic whose submit key
   is restricted to the deployment operator. It writes a progress journal at
   `packages/hardhat/deployments/hedera-testnet.json` and merges public addresses into
   `packages/nextjs/.env.local`.
4. Add the server settings below to `packages/nextjs/.env.local`. The root `.env`
   is read by deployment scripts only. Existing custom RPC, Reown, and server settings
   are preserved when deployment writes new addresses.
5. Run `npm run bootstrap` to attempt pair creation and liquidity seeding, then
   `npm run dev`. Bootstrap failure exits nonzero; it does not establish a live route.

A deployment supplies 400,000 USDX to the pool (the deployer holds its supplier shares)
and adds 100,000 USDX as faucet funds.
Bootstrap requests 100 HBAR and the corresponding six-decimal USDX amount at a fresh
Hermes price. LP tokens remain in the pool contract. Scripts are testnet-only.

### Server settings

| Variable | Location / purpose |
| --- | --- |
| `HERMES_URL` | Root `.env` for bootstrap; Next.js `.env.local` for the server price proxy. Defaults to `https://hermes.pyth.network`. |
| `PYTH_API_KEY` | Server-only Hermes Bearer key. `HERMES_API_KEY` is also accepted. Never prefix a secret with `NEXT_PUBLIC_`. |
| `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` | Root `.env` for deploy; explicitly configure separately in Next.js `.env.local` to enable optional HCS submissions. Use the topic's submit-key account. |
| `ACTIVITY_STORE_DIR` | Next.js server's writable persistent journal directory; default `.data/activity`. Persist it across restarts. |
| `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | Optional Reown project ID in Next.js `.env.local` for WalletConnect wallets. |
| `HEDERA_RPC_URL` | Optional deployment testnet JSON-RPC override. |
| `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_MIRROR_NODE` | Optional public testnet endpoints used by the app. |

`/api/price-update` keeps Hermes credentials on the server. A missing/invalid key
produces a visible setup error; the app does not fabricate signed updates or prices.

`/api/activity` accepts a transaction hash, verifies a recent successful direct pool
transaction, and derives messages from the receipt's pool events. It checks that the
HCS topic has a restricted submit key, deduplicates transactions on disk and caps
paid submissions at 30 verified transactions per UTC hour. Use one durable shared
journal directory for all writers; ephemeral/serverless per-instance storage is not
sufficient. An uncertain paid submission is retained for inspection and is not
blindly retried. The feed is best effort: a successful loan remains successful if
HCS is unavailable. It is not a complete autonomous chain indexer.

### Resuming deployment

Completed journal steps are skipped, including seeds and topic creation. A pending
step means submission or confirmation was interrupted: inspect its stored transaction
hash/ID on Hashscan and reconcile the journal before retrying. Do not delete a pending
step just to force a second payment. Unknown errors are surfaced; only an explicit
`TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT` response is ignored.

Old records without the journal, and records built from different contract bytecode,
are rejected. Preserve the old record separately and deploy a fresh testnet pool to
use corrected accounting; rerunning a script does not upgrade an existing contract.

## Try the market

Connect a supported EVM wallet to Hedera Testnet (chain 296). Associate USDX before
receiving it: the token ID is printed by deploy, and HashPack supports manual token
association. Alternatively use the wallet's own testnet credentials with
`npm run associate`; this only associates that account.

1. Claim 250 USDX from the faucet (one claim per account per hour).
2. Approve and supply USDX.
3. Deposit HBAR collateral and borrow USDX; a fresh signed Pyth update accompanies borrowing.
4. Repay debt, withdraw supplied USDX, or withdraw healthy collateral.
5. Inspect Liquidation Watch and the optional Activity feed. A live liquidation needs
   a working WHBAR/USDX pool with sufficient reserves.

Transactions await successful receipts. Rejected/reverted transactions must not be
reported as successful activity. HBAR wallet transaction `value` has **18 decimals**;
contract calldata and `msg.value` use **8-decimal tinybars**. USDX has **6 decimals**,
and internal USD price/index values have **18**.

## Architecture and risk model

| Integration | Function |
| --- | --- |
| Pyth | Fresh HBAR/USD pull updates for borrowing, collateral withdrawal and liquidation; 120-second freshness limit. |
| SaucerSwap V1 | Liquidation swaps seized native HBAR through `swapExactETHForTokens`, path `[WHBAR, USDX]`. The router wraps HBAR. |
| HTS | Deploy creates USDX, account/contract associations authorize receipt, and transfers use the ERC-20 facade. |
| HCS | Optional restricted-submit topic containing receipt-derived activity messages. |
| Mirror node | Reads topic messages and indexes borrower events for Liquidation Watch. |

The pool holds native HBAR. Borrow/supply balances use scaled shares and indexes.
Borrow rate is 2% + 38% × utilization per year; 10% of earned interest goes to
protocol reserves. Interest is simple within each interval and compounds across
accrual intervals. Views project pending interest; balance-changing operations persist
it. Borrow and withdrawal limits use 75% maximum LTV. Liquidation
eligibility and displayed health use the separate 80% threshold, with a 5% bonus.

Collateral-exhausting liquidation clears the residual debt, consumes protocol reserves
first, then reduces supplier claims proportionally. A complete supplier loss retires
old shares so a new deposit cannot revive wiped claims. Faucet funds and protocol
reserves are excluded from borrowable/withdrawable cash.

Liquidators provide USDX repayment and receive swap proceeds. They must consider
router liquidity, slippage, fees and oracle/DEX price differences; the bonus alone
does not guarantee profit. USDX is assumed to be worth $1 and is a test asset.
Collateral earns no yield. Testnet faucet/admin privileges are intentional template
simplifications, not production lending controls.

```
packages/hardhat/contracts/LendingPool.sol   Accounting, collateral, HTS, Pyth, swaps
packages/hardhat/contracts/fork/             Original MIT constant-product test harness
packages/hardhat/test/                      Local accounting/integration regressions
packages/hardhat/test-fork/                 Network-dependent ecosystem/fork checks
packages/hardhat/scripts/                   Deployment, associations, bootstrap, ABIs
packages/nextjs/app/api/                    Server price proxy and verified HCS writer
packages/nextjs/components/                 Market, positions, liquidations and activity
packages/nextjs/lib/                        Units, wallet receipts, mirror/oracle helpers
```

## Development and validation

```bash
npm ci
npm run audit:production
npm run compile
npm run export-abis     # after contract ABI changes
npm run test            # contracts + app/server + deployment helper regressions
npm run lint            # both workspaces, including TypeScript
npm run build
npm run check           # app checks, including generated projects; no secrets required
npm run check:template  # source repository only: additionally requires template.json
npm run test:fork       # separate mainnet RPC/mirror-node dependent test
```

The scaffold CLI consumes and removes `template.json` after validating it. Therefore
`check` explicitly validates the app; `check:template` (or `./self-check.sh`) is the
strict source-repository gate and fails when the manifest is missing. Generated app
CI runs app checks, while this template repository's CI requires source validation.

GitHub Actions runs local validation on push/PR and rejects high/critical production
dependency advisories. Its manually dispatched workflow also runs the fork test. The self-check reports missing dependencies as a
failure and identifies checks it cannot prove: public scaffolding, rendered browser
behavior, real wallet flows, current testnet deployment evidence and bounty eligibility.

Dependency audit status on September 22, 2026: the production-only audit reports no
advisories. The full tree still reports 17 low-severity package entries stemming
from the unpatched development dependency `elliptic`
([GHSA-848j-6mx2-7j84 / CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84))
in the Hardhat 2/fork toolchain. The production SDK resolves ethers 6.17. Audit scope
matters: the production result does not mean the full development tree has no findings.

## Integration limits and evidence

**SaucerSwap testnet:** the legacy V1 factory previously reverted while creating new
pairs because of HTS association authorization. The script reports pair failure
without claiming the route exists. Legacy testnet addresses remain configured for
read-only inspection: router `0.0.19264`, WHBAR `0.0.15058`. Pyth's testnet address is
`0xa2aa501b19aff244d90cc15a4cf739d2725b5729` (contract `0.0.3042133`), with HBAR/USD feed
`0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd`.
Check [SaucerSwap deployments](https://docs.saucerswap.finance/developers/contracts)
and [Pyth addresses](https://docs.pyth.network/price-feeds/core/contract-addresses/evm)
before changing them.

**What the ecosystem/fork test checks:** the suite separates two kinds of evidence:

- Read-only calls to deployed SaucerSwap mainnet factory `0.0.1062784` and router
  `0.0.3045981` discover the WHBAR/USDC pair and compare the router quote with an
  independent reserve calculation at the same pinned block. These calls do not
  send a transaction or execute a swap.
- A local Hedera mainnet fork supplies HTS WHBAR/USDC assets from the real pair
  (`0.0.1462797`) to a small, independently written MIT constant-product harness.
  A mock oracle drives a price drop, and a local liquidation is checked against
  exact debt, collateral, cash and swap-output assertions.

The local harness uses fixed seeded reserves and test-only native/token float
conversion. It implements no LP token, liquidity mint/burn, TWAP or flash-swap
features. It is **not** SaucerSwap's production implementation. The local liquidation
does not execute through the deployed SaucerSwap router, obtain a signed live Pyth
update or create HTS pairs on the real network. Neither test sends a mainnet
transaction. See the test source and [source-history notices](THIRD_PARTY_NOTICES.md).

### Corrected deployment evidence (September 22, 2026)

- [LendingPool 0.0.10660545](https://hashscan.io/testnet/contract/0.0.10660545)
- [USDX 0.0.10660541](https://hashscan.io/testnet/token/0.0.10660541)
- [Restricted HCS topic 0.0.10660569](https://hashscan.io/testnet/topic/0.0.10660569)
  and [verified message readback](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10660569/messages)
- [Deposit 1 HBAR](https://hashscan.io/testnet/transaction/0xf975a0b2dc24f3904953c3e9f6535ac114a4b5df2f9fc581b0b9f1c1848200e5)
  and [withdraw it with zero debt and no oracle update](https://hashscan.io/testnet/transaction/0x6beac47adbcd5ab144b8498bdcfdc01bd22fc73081d73d3359ba788d4949ff0a)
- [Supply 10 USDX](https://hashscan.io/testnet/transaction/0x828d4409113674259f27382f6c21deb9b60e0ab2e7bdeefd83a51b88d38f02d4)
  and [withdraw 10 USDX](https://hashscan.io/testnet/transaction/0x6a600be5c7d70403eac9151eb3b549e6931d693d9b5ed53120d40e50992e36b1)
- [Claim 250 USDX from the faucet](https://hashscan.io/testnet/transaction/0xa39a0b1272b324029c4058897d019d113b39e680f67881839d8b9f4098351ffd)

These transactions were verified with RPC receipts and before/after balance assertions.
The HCS API published the confirmed deposit as message 1, returned the same sequence
on a duplicate request without resubmitting, and rejected caller-supplied event fields.
The configured production build rendered the recorded message through the mirror node.
Borrowing with a live signed Pyth update remains unverified without authorized Hermes
access, and the testnet SaucerSwap route remains unavailable. The fork test covers liquidation only within the scope described above.

Historical evidence below belongs to the earlier contract revision:

- [Pool 0.0.10658737](https://hashscan.io/testnet/contract/0.0.10658737)
- [USDX 0.0.10657747](https://hashscan.io/testnet/token/0.0.10657747)
- [HCS topic 0.0.10658821](https://hashscan.io/testnet/topic/0.0.10658821) and
  [mirror messages](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10658821/messages)
- [Successful collateral deposit](https://hashscan.io/testnet/transaction/0xe4b40b39f05ee40a4fa8ae1eed1c4a1470717e149f5d7d0defe7586a693f0660)

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Hermes HTTP 401/403 | Configure authorized server `PYTH_API_KEY` and endpoint; restart/redeploy the Next.js server. |
| Token association error | Associate USDX with the receiving wallet; unrelated association errors are not ignored. |
| Bootstrap exits nonzero | Inspect the transaction and journal; do not assume liquidations can swap. Use the separate fork test for its stated scope. |
| HCS unavailable | Check server-only credentials, topic submit key and durable journal permissions; the chain receipt remains the source of transaction truth. |
| Pending deployment step | Reconcile the saved transaction against consensus before resubmission. |

## License

Current LettermanLabs application, contracts and test harness are [MIT](LICENSE).
Earlier revisions contained GPL-derived AMM fixtures; those were replaced, and their
original licensing is preserved in repository history. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for historical attribution and notices.
