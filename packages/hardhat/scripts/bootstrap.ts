/**
 * Seeds the SaucerSwap V1 WHBAR/USDX liquidity pool so liquidations have a swap route.
 * The pool's LP tokens are sent to the LendingPool contract (locked testnet liquidity).
 *
 * Run after deploy: npm run bootstrap
 */
import { ethers } from "hardhat";
import { AMM_SEED_HBAR, TESTNET } from "./lib/config";
import { LendingPool__factory } from "../typechain-types";
import { ethersProvider, ethersSigner, hashscanTx } from "./lib/setup";
import { loadDeployment, saveDeployment } from "./lib/record";

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
];
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function createPair(address tokenA, address tokenB) returns (address pair)",
];
const ERC20_ABI = ["function approve(address spender, uint256 amount) returns (bool)"];

interface HermesPrice {
  price: string;
  expo: number;
}

async function fetchHbarUsd(): Promise<HermesPrice> {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${TESTNET.hbarUsdPriceId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes request failed: ${res.status}`);
  const json = (await res.json()) as { parsed: { price: HermesPrice }[] };
  return json.parsed[0].price;
}

async function main() {
  const record = loadDeployment();
  if (!record) throw new Error("No deployment found — run `npm run deploy` first.");

  const signer = ethersSigner();
  const router = new ethers.Contract(TESTNET.saucerSwapRouter, ROUTER_ABI, signer);
  const factoryAddress = await router.factory();
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, signer);

  console.log(`\nSaucerSwap V1 router: ${TESTNET.saucerSwapRouter} (factory ${factoryAddress})`);

  // 1 ── Ensure the WHBAR/USDX pair exists ───────────────────────────────────
  let pair: string = await factory.getPair(TESTNET.whbar, record.usdxEvm);
  if (pair === ethers.ZeroAddress) {
    console.log("\n1. Creating WHBAR/USDX pair…");
    const tx = await factory.createPair(TESTNET.whbar, record.usdxEvm);
    await tx.wait();
    pair = await factory.getPair(TESTNET.whbar, record.usdxEvm);
  } else {
    console.log(`\n1. Pair already exists: ${pair}`);
  }

  // 2 ── Associate the pool contract with the LP token so it can receive it ──
  console.log("\n2. Associating pool contract with the LP token…");
  const pool = LendingPool__factory.connect(record.lendingPool, signer);
  const assocTx = await pool.associateToken(pair);
  const assocRc = await assocTx.wait();
  console.log(`   tx: ${hashscanTx(assocRc!.hash)}`);

  // 3 ── Seed liquidity at the current Pyth HBAR/USD price ───────────────────
  console.log("\n3. Seeding liquidity…");
  const { price, expo } = await fetchHbarUsd();
  console.log(`   Pyth HBAR/USD: ${price} (expo ${expo})`);
  // AMM_SEED_HBAR has 8 decimals; price has `expo` decimals → USD in 8 decimals,
  // then downscale 8dp → 6dp for USDX.
  const usdxAmount = (AMM_SEED_HBAR * BigInt(price)) / 10n ** BigInt(8 + expo + 2);

  const usdx = new ethers.Contract(record.usdxEvm, ERC20_ABI, signer);
  await (await usdx.approve(await router.getAddress(), usdxAmount)).wait();

  const latest = await ethersProvider().getBlock("latest");
  const deadline = BigInt(latest!.timestamp) + 600n;

  const tx = await router.addLiquidityETH(
    record.usdxEvm,
    usdxAmount,
    (usdxAmount * 99n) / 100n,
    (AMM_SEED_HBAR * 99n) / 100n,
    record.lendingPool, // LP tokens go to the pool contract (locked)
    deadline,
    { value: AMM_SEED_HBAR },
  );
  const rc = await tx.wait();
  console.log(`   added ${AMM_SEED_HBAR / 10n ** 8n} HBAR + ${usdxAmount / 10n ** 6n} USDX`);
  console.log(`   tx: ${hashscanTx(rc!.hash)}`);

  record.ammPair = pair;
  saveDeployment(record);
  console.log("\n✅ AMM bootstrap complete — the liquidation swap route is live.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
