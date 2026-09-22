/**
 * Deploys the Hedera Lending Market to Hedera testnet:
 *   1. Creates USDX — the borrowable asset — as a native HTS token (treasury = deployer)
 *   2. Deploys the LendingPool contract
 *   3. Associates the pool with WHBAR + USDX via the HTS precompile (0x167)
 *   4. Seeds pool liquidity and the testnet faucet
 *   5. Creates the HCS activity topic
 *   6. Records everything for the frontend (packages/nextjs/.env.local)
 *
 * The script is resumable: progress is saved after the pool is deployed, so a
 * retry after a mid-script failure reuses the on-chain state instead of
 * redeploying.
 *
 * Run: npm run deploy
 */
import * as fs from "fs";
import * as path from "path";
import { ethers } from "hardhat";
import {
  ContractCreateFlow,
  ContractFunctionParameters,
  Hbar,
  TokenMintTransaction,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { FAUCET_SEED_USDX, POOL_LIQUIDITY_USDX, TESTNET, USDX_TOTAL_SUPPLY, idToEvmAddress } from "./lib/config";
import { ethersSigner, hashscanContract, hederaClient, requireEnv } from "./lib/setup";
import { loadDeployment, saveDeployment } from "./lib/record";
import { LendingPool__factory } from "../typechain-types";

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
  const { accountId, operatorKey, accountIdString } = requireEnv();
  const client = hederaClient();
  const signer = ethersSigner();
  console.log(`\nDeployer: ${accountIdString} (EVM ${signer.address})`);

  let usdxTokenId: string;
  let usdxEvm: string;
  let poolAddress: string;
  let poolContractId: string;

  const existing = loadDeployment();
  if (existing?.lendingPool && existing.usdxTokenId && existing.lendingPoolId) {
    // ── Resume from a previous (possibly interrupted) deployment ─────────────
    console.log("\nResuming from previous deployment:");
    console.log(`   USDX: ${existing.usdxTokenId}   Pool: ${existing.lendingPoolId}`);
    usdxTokenId = existing.usdxTokenId;
    usdxEvm = existing.usdxEvm;
    poolAddress = existing.lendingPool;
    poolContractId = existing.lendingPoolId;
  } else {
    if (existing?.usdxTokenId) {
      // ── USDX already created in a previous run — reuse it ──────────────────
      console.log(`\nReusing USDX from previous run: ${existing.usdxTokenId}`);
      usdxTokenId = existing.usdxTokenId;
      usdxEvm = existing.usdxEvm;
    } else {
      // 1 ── Create USDX, the HTS borrowable asset ──────────────────────────────
      console.log("\n1. Creating USDX via the Hedera Token Service…");
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
      usdxTokenId = createReceipt.tokenId!.toString();
      usdxEvm = idToEvmAddress(usdxTokenId);
      console.log(`   USDX token: ${usdxTokenId} (EVM ${usdxEvm})`);

      // Save immediately so the next run reuses the token.
      saveDeployment({
        network: "hedera-testnet",
        usdxTokenId,
        usdxEvm,
        whbar: TESTNET.whbar,
        pyth: TESTNET.pyth,
        hbarUsdPriceId: TESTNET.hbarUsdPriceId,
        saucerSwapRouter: TESTNET.saucerSwapRouter,
        deployedAt: new Date().toISOString(),
      });
    }

    // 2 ── Deploy the lending pool via HAPI with an admin key ─────────────────
    // The admin key lets the pool authorize its own HTS associations (a plain
    // EVM CREATE leaves the contract keyless, and precompile self-association
    // would fail with INVALID_SIGNATURE). The bytecode is stored in a file
    // first — HAPI transactions are capped at 6KB.
    console.log("\n2. Deploying LendingPool (HAPI contract create with admin key)…");
    const artifactPath = path.join(__dirname, "../artifacts/contracts/LendingPool.sol/LendingPool.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

    const params = new ContractFunctionParameters()
      .addAddress(TESTNET.whbar)
      .addAddress(usdxEvm)
      .addAddress(TESTNET.pyth)
      .addBytes32(Uint8Array.from(Buffer.from(TESTNET.hbarUsdPriceId.slice(2), "hex")))
      .addAddress(TESTNET.saucerSwapRouter);
    // ContractCreateFlow stores the initcode in file storage (6KB tx limit) and
    // deploys in one call.
    const contractTx = await new ContractCreateFlow()
      .setBytecode(artifact.bytecode)
      .setGas(4_000_000)
      .setAdminKey(operatorKey.publicKey)
      .setConstructorParameters(params);

    const contractReceipt = await (await contractTx.execute(client)).getReceipt(client);
    poolContractId = contractReceipt.contractId!.toString();
    poolAddress = idToEvmAddress(poolContractId);
    console.log(`   LendingPool: ${poolContractId} (EVM ${poolAddress})`);

    // Save immediately so the next run resumes from here.
    saveDeployment({
      network: "hedera-testnet",
      lendingPool: poolAddress,
      lendingPoolId: poolContractId,
      usdxTokenId,
      usdxEvm,
      whbar: TESTNET.whbar,
      pyth: TESTNET.pyth,
      hbarUsdPriceId: TESTNET.hbarUsdPriceId,
      saucerSwapRouter: TESTNET.saucerSwapRouter,
      deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    });
  }

  const pool = LendingPool__factory.connect(poolAddress, signer);

  // 3 ── Associate the pool contract with WHBAR + USDX ─────────────────────────
  // Done via HAPI (signed by the pool's admin key = operator): a contract can
  // only authorize its own HTS associations when its key signs the transaction.
  console.log("\n3. Associating pool contract with WHBAR + USDX via HAPI…");
  {
    try {
      const assocTx = await new TokenAssociateTransaction()
        .setAccountId(poolContractId)
        .setTokenIds([WHBAR_TOKEN_ID, usdxTokenId])
        .freezeWith(client)
        .sign(operatorKey);
      const assocReceipt = await (await assocTx.execute(client)).getReceipt(client);
      console.log(`   status: ${assocReceipt.status.toString()}`);
    } catch {
      console.log("   already associated — continuing");
    }
  }

  // 4 ── Seed liquidity + faucet ───────────────────────────────────────────────
  console.log("\n4. Seeding pool liquidity and faucet…");
  await associateIfNeeded(usdxTokenId);
  await associateIfNeeded(WHBAR_TOKEN_ID);

  const usdx = new ethers.Contract(usdxEvm, ERC20_ABI, signer);

  // Mint more USDX if a previous (resumed) run already spent the treasury —
  // the deployer holds the token's supply key.
  const needed = POOL_LIQUIDITY_USDX + FAUCET_SEED_USDX;
  const treasuryBalance: bigint = await usdx.balanceOf(signer.address);
  if (treasuryBalance < needed) {
    const deficit = needed - treasuryBalance;
    const mintTx = await new TokenMintTransaction()
      .setTokenId(usdxTokenId)
      .setAmount(Number(deficit))
      .freezeWith(client)
      .sign(operatorKey);
    await (await mintTx.execute(client)).getReceipt(client);
    console.log(`   minted ${deficit / 10n ** 6n} USDX to treasury (resumed run)`);
  }

  await (await usdx.transfer(poolAddress, POOL_LIQUIDITY_USDX, { gasLimit: 2_000_000 })).wait();
  console.log(`   transferred ${POOL_LIQUIDITY_USDX / 10n ** 6n} USDX to pool`);

  await (await usdx.approve(poolAddress, FAUCET_SEED_USDX, { gasLimit: 2_000_000 })).wait();
  await (await pool.fundFaucet(FAUCET_SEED_USDX, { gasLimit: 2_000_000 })).wait();
  console.log(`   funded faucet with ${FAUCET_SEED_USDX / 10n ** 6n} USDX`);

  // 5 ── Create the HCS activity topic ─────────────────────────────────────────
  let topicId = existing?.hcsTopicId;
  if (!topicId) {
    console.log("\n5. Creating HCS activity topic…");
    const topicTx = await new TopicCreateTransaction()
      .setTopicMemo("HederaLendingTemplate activity feed")
      .setAdminKey(operatorKey.publicKey)
      .freezeWith(client)
      .sign(operatorKey);
    const topicReceipt = await (await topicTx.execute(client)).getReceipt(client);
    topicId = topicReceipt.topicId!.toString();
  }
  console.log(`   topic: ${topicId}`);

  // 6 ── Record for the frontend ───────────────────────────────────────────────
  saveDeployment({
    network: "hedera-testnet",
    lendingPool: poolAddress,
    lendingPoolId: poolContractId,
    usdxTokenId,
    usdxEvm,
    whbar: TESTNET.whbar,
    pyth: TESTNET.pyth,
    hbarUsdPriceId: TESTNET.hbarUsdPriceId,
    saucerSwapRouter: TESTNET.saucerSwapRouter,
    hcsTopicId: topicId,
    ammPair: existing?.ammPair,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
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
