/**
 * Deploys the Hedera Lending Market to Hedera testnet:
 *   1. Creates USDX — the borrowable asset — as a native HTS token (treasury = deployer)
 *   2. Deploys the LendingPool contract
 *   3. Associates the pool with WHBAR + USDX via the HTS precompile (0x167)
 *   4. Seeds pool liquidity and the testnet faucet
 *   5. Creates the HCS activity topic
 *   6. Records everything for the frontend (packages/nextjs/.env.local)
 *
 * Run: npm run deploy
 */
import { ethers } from "hardhat";
import { TokenAssociateTransaction, TokenCreateTransaction, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { FAUCET_SEED_USDX, POOL_LIQUIDITY_USDX, TESTNET, USDX_TOTAL_SUPPLY, idToEvmAddress } from "./lib/config";
import { ethersSigner, hashscanContract, hashscanTx, hederaClient, requireEnv } from "./lib/setup";
import { saveDeployment } from "./lib/record";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const WHBAR_TOKEN_ID = "0.0.15058";

async function associateIfNeeded(tokenId: string): Promise<void> {
  const client = hederaClient();
  const { accountId, operatorKey } = requireEnv();
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([tokenId])
      .freezeWith(client)
      .sign(operatorKey);
    await (await tx.execute(client)).getReceipt(client);
    console.log(`  associated ${tokenId} with operator`);
  } catch {
    // TOKEN_ALREADY_ASSOCIATED — safe to ignore
    console.log(`  operator already associated with ${tokenId}`);
  }
}

async function main() {
  const { accountIdString } = requireEnv();
  const signer = ethersSigner();
  console.log(`\nDeployer: ${accountIdString} (EVM ${signer.address})`);

  // 1 ── Create USDX, the HTS borrowable asset ──────────────────────────────
  console.log("\n1. Creating USDX via the Hedera Token Service…");
  const client = hederaClient();
  const { accountId, operatorKey } = requireEnv();
  const createTx = await new TokenCreateTransaction()
    .setTokenName("LendDollar")
    .setTokenSymbol("USDX")
    .setDecimals(6)
    .setInitialSupply(Number(USDX_TOTAL_SUPPLY))
    .setTreasuryAccountId(accountId)
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .setTokenMemo("HederaLendingTemplate borrowable asset (testnet)")
    .freezeWith(client)
    .sign(operatorKey);
  const createReceipt = await (await createTx.execute(client)).getReceipt(client);
  const usdxTokenId = createReceipt.tokenId!.toString();
  const usdxEvm = idToEvmAddress(usdxTokenId);
  console.log(`   USDX token: ${usdxTokenId} (EVM ${usdxEvm})`);

  // 2 ── Deploy the lending pool ─────────────────────────────────────────────
  console.log("\n2. Deploying LendingPool…");
  const poolFactory = await ethers.getContractFactory("LendingPool");
  const pool = await poolFactory.deploy(
    TESTNET.whbar,
    usdxEvm,
    TESTNET.pyth,
    TESTNET.hbarUsdPriceId,
    TESTNET.saucerSwapRouter,
  );
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  const deployHash = pool.deploymentTransaction()!.hash;
  console.log(`   LendingPool: ${poolAddress}`);
  console.log(`   deploy tx:   ${hashscanTx(deployHash)}`);

  // 3 ── Associate the pool contract with WHBAR + USDX (HTS precompile) ──────
  console.log("\n3. Associating pool contract with WHBAR + USDX via HTS precompile…");
  const assoc = await pool.connect(signer).associateTokens();
  await assoc.wait();
  console.log("   associated");

  // 4 ── Seed liquidity + faucet ─────────────────────────────────────────────
  console.log("\n4. Seeding pool liquidity and faucet…");
  await associateIfNeeded(usdxTokenId);
  await associateIfNeeded(WHBAR_TOKEN_ID);

  const usdx = new ethers.Contract(usdxEvm, ERC20_ABI, signer);
  const poolAsSigner = pool.connect(signer);

  await (await usdx.transfer(poolAddress, POOL_LIQUIDITY_USDX)).wait();
  console.log(`   transferred ${POOL_LIQUIDITY_USDX / 10n ** 6n} USDX to pool`);

  await (await usdx.approve(poolAddress, FAUCET_SEED_USDX)).wait();
  await (await poolAsSigner.fundFaucet(FAUCET_SEED_USDX)).wait();
  console.log(`   funded faucet with ${FAUCET_SEED_USDX / 10n ** 6n} USDX`);

  // 5 ── Create the HCS activity topic ───────────────────────────────────────
  console.log("\n5. Creating HCS activity topic…");
  const topicTx = await new TopicCreateTransaction()
    .setTopicMemo("HederaLendingTemplate activity feed")
    .setAdminKey(operatorKey.publicKey)
    .freezeWith(client)
    .sign(operatorKey);
  const topicReceipt = await (await topicTx.execute(client)).getReceipt(client);
  const topicId = topicReceipt.topicId!.toString();
  console.log(`   topic: ${topicId}`);

  // 6 ── Record for the frontend ─────────────────────────────────────────────
  saveDeployment({
    network: "hedera-testnet",
    lendingPool: poolAddress,
    usdxTokenId,
    usdxEvm,
    whbar: TESTNET.whbar,
    pyth: TESTNET.pyth,
    hbarUsdPriceId: TESTNET.hbarUsdPriceId,
    saucerSwapRouter: TESTNET.saucerSwapRouter,
    hcsTopicId: topicId,
    deployedAt: new Date().toISOString(),
  });

  console.log("\n✅ Deployment complete");
  console.log(`   Pool contract: ${hashscanContract(poolAddress)}`);
  console.log(`   USDX token:    ${TESTNET.hashscan}/token/${usdxTokenId}`);
  console.log(`   HCS topic:     ${TESTNET.hashscan}/topic/${topicId}`);
  console.log("\nNext: npm run bootstrap   (seed the SaucerSwap WHBAR/USDX pool for liquidations)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
