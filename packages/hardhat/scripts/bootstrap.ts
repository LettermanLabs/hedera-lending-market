/** Seeds the testnet WHBAR/USDX pair and records only confirmed completion. */
import { ethers } from "hardhat";
import { TokenAssociateTransaction } from "@hiero-ledger/sdk";
import { AMM_SEED_HBAR_WEI, TESTNET } from "./lib/config";
import { ethersProvider, ethersSigner, hashscanTx, hederaClient, requireEnv } from "./lib/setup";
import { beginStep, completeStep, loadDeployment, saveDeployment } from "./lib/record";
import { bootstrapAmounts, tinycentsToRpcValue } from "./lib/amounts";

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

/** Fetch a fresh seed ratio from the same Hermes source configured for the app. */
async function fetchHbarUsd(): Promise<HermesPrice> {
  const base = process.env.HERMES_URL || "https://hermes.pyth.network";
  const url = new URL("v2/updates/price/latest", base.endsWith("/") ? base : `${base}/`);
  url.searchParams.append("ids[]", TESTNET.hbarUsdPriceId);
  const key = process.env.PYTH_API_KEY || process.env.HERMES_API_KEY;
  const res = await fetch(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    throw new Error(
      `Hermes returned HTTP ${res.status}. Configure HERMES_URL and PYTH_API_KEY in the root .env before bootstrap.`,
    );
  const json = (await res.json()) as { parsed?: { id: string; price: HermesPrice & { publish_time: number } }[] };
  const item = json.parsed?.find(
    (entry) => entry.id.replace(/^0x/, "").toLowerCase() === TESTNET.hbarUsdPriceId.slice(2),
  );
  if (
    !item ||
    !Number.isFinite(item.price.publish_time) ||
    Math.abs(Date.now() / 1000 - item.price.publish_time) > 120
  ) {
    throw new Error("Hermes returned no fresh HBAR/USD price");
  }
  return item.price;
}

async function main() {
  const record = loadDeployment();
  if (!record?.lendingPool || !record.lendingPoolId || record.version !== 2) {
    throw new Error("No current deployment found — run npm run deploy first (see README for legacy records).");
  }
  if (record.steps?.ammSeed?.status === "complete") {
    console.log(`AMM seed already completed: ${record.ammPair}. No funds transferred.`);
    return;
  }
  for (const name of ["ammSeed", "createPair"]) {
    if (record.steps?.[name]?.status === "pending") beginStep(record, name);
  }
  const signer = ethersSigner();
  const provider = ethersProvider();
  if ((await provider.getNetwork()).chainId !== 296n) throw new Error("Bootstrap is testnet only");
  const { operatorKey, accountIdString } = requireEnv();
  if (record.operator !== accountIdString) throw new Error("Bootstrap signer differs from the deployment operator");
  const router = new ethers.Contract(record.saucerSwapRouter, ROUTER_ABI, signer);
  const factory = new ethers.Contract(await router.factory(), FACTORY_ABI, signer);
  const { price, expo } = await fetchHbarUsd();
  const { usdx6, hbar8, value18 } = bootstrapAmounts(AMM_SEED_HBAR_WEI, price, expo);

  let pair: string = await factory.getPair(record.whbar, record.usdxEvm);
  if (pair === ethers.ZeroAddress) {
    const fee: bigint = (await factory.pairCreateFee()) + (await factory.tokenCreateFee());
    // Factory USD fees are rounded up to a representable RPC amount.
    const createFee = tinycentsToRpcValue(fee, price, expo);
    beginStep(record, "createPair");
    try {
      const tx = await factory.createPair(record.whbar, record.usdxEvm, { value: createFee, gasLimit: 3_000_000 });
      record.steps!.createPair.transactionHash = tx.hash;
      saveDeployment(record);
      await tx.wait();
      pair = await factory.getPair(record.whbar, record.usdxEvm);
      if (pair === ethers.ZeroAddress) throw new Error("Factory did not return a created pair");
      record.ammPair = pair;
      completeStep(record, "createPair");
    } catch {
      throw new Error(
        "Pair creation did not complete. The legacy SaucerSwap testnet factory may reject HTS associations; inspect the recorded transaction before retrying. The local mainnet-fork harness is a separate validation path, not a live swap route.",
      );
    }
  }
  record.ammPair = pair;
  saveDeployment(record);

  // SaucerSwap's LP is a separate HTS token, not the pair contract address.
  const pairContract = new ethers.Contract(pair, ["function lpToken() view returns (address)"], signer);
  const lpToken: string = await pairContract.lpToken();
  if (!/^0x0{24}[0-9a-fA-F]{16}$/.test(lpToken) || BigInt(lpToken) === 0n)
    throw new Error("Unexpected HTS LP token address");
  const client = hederaClient();
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(record.lendingPoolId)
      .setTokenIds([`0.0.${BigInt(lpToken)}`])
      .freezeWith(client)
      .sign(operatorKey);
    await (await tx.execute(client)).getReceipt(client);
  } catch (error) {
    if (!String(error).includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) throw error;
  } finally {
    client.close();
  }

  const usdx = new ethers.Contract(record.usdxEvm, ERC20_ABI, signer);
  await (await usdx.approve(await router.getAddress(), usdx6, { gasLimit: 2_000_000 })).wait();
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Cannot read latest block");
  beginStep(record, "ammSeed");
  const tx = await router.addLiquidityETH(
    record.usdxEvm,
    usdx6,
    (usdx6 * 99n) / 100n,
    (hbar8 * 99n) / 100n,
    record.lendingPool,
    BigInt(latest.timestamp) + 600n,
    { value: value18, gasLimit: 4_000_000 },
  );
  record.steps!.ammSeed.transactionHash = tx.hash;
  saveDeployment(record);
  await tx.wait();
  completeStep(record, "ammSeed");
  console.log(`Seeded ${ethers.formatUnits(hbar8, 8)} HBAR + ${ethers.formatUnits(usdx6, 6)} USDX`);
  console.log(`Transaction: ${hashscanTx(tx.hash)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
