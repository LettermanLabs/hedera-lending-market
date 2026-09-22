/**
 * Seeds the SaucerSwap V1 WHBAR/USDX liquidity pool so liquidations have a swap route.
 * The pool's LP tokens are sent to the LendingPool contract (locked testnet liquidity).
 *
 * Run after deploy: npm run bootstrap
 */
import { ethers } from "hardhat";
import { TokenAssociateTransaction } from "@hiero-ledger/sdk";
import { AMM_SEED_HBAR_WEI, TESTNET } from "./lib/config";
import { ethersProvider, ethersSigner, hashscanTx, hederaClient, requireEnv } from "./lib/setup";
import { loadDeployment, saveDeployment } from "./lib/record";

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
];
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function createPair(address tokenA, address tokenB) payable returns (address pair)",
  "function pairCreateFee() view returns (uint256)",
  "function tokenCreateFee() view returns (uint256)",
];
const ERC20_ABI = ["function approve(address spender, uint256 amount) returns (bool)"];

interface HermesPrice {
  price: string;
  expo: number;
}

/**
 * Fetches HBAR/USD from Hermes (the same source the pool's pull oracle uses).
 * Falls back to CoinGecko's public API if Hermes is unavailable — the bootstrap
 * only needs an approximate price for the pair-creation fee conversion and the
 * initial pool ratio.
 */
async function fetchHbarUsd(): Promise<HermesPrice> {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${TESTNET.hbarUsdPriceId}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { parsed: { price: HermesPrice }[] };
    return json.parsed[0].price;
  } catch (e) {
    console.log(`   Hermes unavailable (${(e as Error).message}) — falling back to CoinGecko`);
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd");
    if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status}`);
    const json = (await res.json()) as { "hedera-hashgraph": { usd: number } };
    return { price: String(Math.round(json["hedera-hashgraph"].usd * 1e8)), expo: -8 };
  }
}

async function main() {
  const record = loadDeployment();
  if (!record) throw new Error("No deployment found — run `npm run deploy` first.");

  const signer = ethersSigner();
  const router = new ethers.Contract(TESTNET.saucerSwapRouter, ROUTER_ABI, signer);
  const factoryAddress = await router.factory();
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, signer);

  console.log(`\nSaucerSwap V1 router: ${TESTNET.saucerSwapRouter} (factory ${factoryAddress})`);

  // Fetch the Pyth HBAR/USD price up front — needed for both the pair-creation
  // fee conversion (factory fees are denominated in tinycents) and the liquidity ratio.
  const { price, expo } = await fetchHbarUsd();
  const hbarUsd = Number(price) * 10 ** expo;
  console.log(`   Pyth HBAR/USD: $${hbarUsd.toFixed(4)}`);

  // 1 ── Ensure the WHBAR/USDX pair exists ───────────────────────────────────
  let pair: string = await factory.getPair(TESTNET.whbar, record.usdxEvm);
  if (pair === ethers.ZeroAddress) {
    console.log("\n1. Creating WHBAR/USDX pair…");
    // msg.value must cover BOTH tinycent-denominated fees (pairCreateFee +
    // tokenCreateFee, the latter forwarded to the LP-token creation):
    //   tinycents → USD (÷1e10) → HBAR (÷price) → wei (×1e18)
    const totalTinycents = (await factory.pairCreateFee()) + (await factory.tokenCreateFee());
    const createFeeWei = BigInt(Math.round((Number(totalTinycents) / 1e10 / hbarUsd) * 1e18));
    console.log(`   create fees: ${totalTinycents} tinycents ≈ ${createFeeWei / 10n ** 18n} HBAR`);
    try {
      const tx = await factory.createPair(TESTNET.whbar, record.usdxEvm, {
        value: createFeeWei,
        gasLimit: 3_000_000,
      });
      await tx.wait();
      pair = await factory.getPair(TESTNET.whbar, record.usdxEvm);
    } catch {
      console.log(
        "\n⚠️  SaucerSwap V1 pair creation reverted. The legacy testnet factory can no longer\n" +
          "    authorize its pair contracts' HTS associations (a known testnet limitation — the\n" +
          "    canonical SaucerSwap docs no longer list testnet deployments). The liquidation\n" +
          "    swap path is therefore evidenced against a FORKED HEDERA MAINNET instead — see\n" +
          "    `npm run test:fork` and the README ('SaucerSwap testnet status').\n",
      );
      return;
    }
  } else {
    console.log(`\n1. Pair already exists: ${pair}`);
  }

  // 2 ── Associate the pool contract with the LP token so it can receive it ──
  // Via HAPI, signed by the pool's admin key (contracts can only authorize their
  // own HTS associations when their key signs the transaction).
  console.log("\n2. Associating pool contract with the LP token…");
  const pairTokenId = "0.0." + BigInt(pair).toString(10);
  const { operatorKey } = requireEnv();
  const assocTx = await new TokenAssociateTransaction()
    .setAccountId(record.lendingPoolId!)
    .setTokenIds([pairTokenId])
    .freezeWith(hederaClient())
    .sign(operatorKey);
  const assocReceipt = await (await assocTx.execute(hederaClient())).getReceipt(hederaClient());
  console.log(`   status: ${assocReceipt.status.toString()} (LP token ${pairTokenId})`);

  // 3 ── Seed liquidity at the current Pyth HBAR/USD price ───────────────────
  console.log("\n3. Seeding liquidity…");
  // AMM_SEED_HBAR_WEI is 18-decimal wei; price has `expo` decimals → USDX (6dp):
  //   usdx6 = wei × priceRaw ÷ 10^(18 - expo)
  const usdxAmount = (AMM_SEED_HBAR_WEI * BigInt(price)) / 10n ** BigInt(18 - expo);

  const usdx = new ethers.Contract(record.usdxEvm, ERC20_ABI, signer);
  await (await usdx.approve(await router.getAddress(), usdxAmount, { gasLimit: 2_000_000 })).wait();

  const latest = await ethersProvider().getBlock("latest");
  const deadline = BigInt(latest!.timestamp) + 600n;

  const tx = await router.addLiquidityETH(
    record.usdxEvm,
    usdxAmount,
    (usdxAmount * 99n) / 100n,
    (AMM_SEED_HBAR_WEI * 99n) / 100n,
    record.lendingPool!, // LP tokens go to the pool contract (locked)
    deadline,
    { value: AMM_SEED_HBAR_WEI, gasLimit: 4_000_000 },
  );
  const rc = await tx.wait();
  console.log(`   added ${AMM_SEED_HBAR_WEI / 10n ** 18n} HBAR + ${usdxAmount / 10n ** 6n} USDX`);
  console.log(`   tx: ${hashscanTx(rc!.hash)}`);

  record.ammPair = pair;
  saveDeployment(record);
  console.log("\n✅ AMM bootstrap complete — the liquidation swap route is live.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
