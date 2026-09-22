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
import { createHash } from "crypto";
import * as path from "path";
import { ethers } from "hardhat";
import {
  ContractCreateFlow,
  ContractFunctionParameters,
  TokenMintTransaction,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { FAUCET_SEED_USDX, POOL_LIQUIDITY_USDX, TESTNET, USDX_TOTAL_SUPPLY, idToEvmAddress } from "./lib/config";
import { ethersSigner, hashscanContract, hederaClient, requireEnv } from "./lib/setup";
import { beginStep, completeStep, loadDeployment, saveDeployment } from "./lib/record";
import { waitForIndexedContract } from "./lib/readiness";
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
  } catch (error) {
    if (!String(error).includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) throw error;
    // Only a confirmed already-associated status is safe to ignore
    console.log(`  operator already associated with ${tokenId}`);
  } finally {
    client.close();
  }
}

async function main() {
  const { accountId, operatorKey, accountIdString } = requireEnv();
  const client = hederaClient();
  try {
    const signer = ethersSigner();
    if ((await signer.provider!.getNetwork()).chainId !== 296n) throw new Error("Deployment is testnet only");
    console.log(`\nDeployer: ${accountIdString} (EVM ${signer.address})`);

    let usdxTokenId: string;
    let usdxEvm: string;
    let poolAddress: string;
    let poolContractId: string;

    const artifactPath = path.join(__dirname, "../artifacts/contracts/LendingPool.sol/LendingPool.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const artifactHash = createHash("sha256").update(artifact.bytecode).digest("hex");
    const existing = loadDeployment();
    if (existing && (existing.version !== 2 || existing.artifactHash !== artifactHash)) {
      throw new Error(
        "This deployment record predates the safe resume journal or uses different contract bytecode. Archive the old record (keep its addresses), then deploy a fresh testnet pool. Existing contracts are not upgraded by rerunning this script.",
      );
    }
    if (existing?.operator && existing.operator !== accountIdString)
      throw new Error("Deployment operator differs from the recorded owner.");
    const record = existing ?? {
      version: 2 as const,
      network: "hedera-testnet",
      operator: accountIdString,
      artifactHash,
      usdxTokenId: "",
      usdxEvm: "",
      whbar: TESTNET.whbar,
      pyth: TESTNET.pyth,
      hbarUsdPriceId: TESTNET.hbarUsdPriceId,
      saucerSwapRouter: TESTNET.saucerSwapRouter,
      deployedAt: new Date().toISOString(),
      steps: {},
    };
    saveDeployment(record);
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
        beginStep(record, "createUsdx");
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
        record.steps!.createUsdx.transactionId = createTx.transactionId!.toString();
        saveDeployment(record);
        const createReceipt = await (await createTx.execute(client)).getReceipt(client);
        usdxTokenId = createReceipt.tokenId!.toString();
        usdxEvm = idToEvmAddress(usdxTokenId);
        console.log(`   USDX token: ${usdxTokenId} (EVM ${usdxEvm})`);

        record.usdxTokenId = usdxTokenId;
        record.usdxEvm = usdxEvm;
        completeStep(record, "createUsdx");
      }

      // 2 ── Deploy the lending pool via HAPI with an admin key ─────────────────
      // The admin key lets the pool authorize its own HTS associations (a plain
      // EVM CREATE leaves the contract keyless, and precompile self-association
      // would fail with INVALID_SIGNATURE). The bytecode is stored in a file
      // first — HAPI transactions are capped at 6KB.
      console.log("\n2. Deploying LendingPool (HAPI contract create with admin key)…");
      beginStep(record, "createPool");

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

      const contractResponse = await contractTx.execute(client);
      record.steps!.createPool.transactionId = contractResponse.transactionId.toString();
      saveDeployment(record);
      const contractReceipt = await contractResponse.getReceipt(client);
      poolContractId = contractReceipt.contractId!.toString();
      poolAddress = idToEvmAddress(poolContractId);
      console.log(`   LendingPool: ${poolContractId} (EVM ${poolAddress})`);

      record.lendingPool = poolAddress;
      record.lendingPoolId = poolContractId;
      completeStep(record, "createPool");
    }

    const pool = LendingPool__factory.connect(poolAddress, signer);
    const admin = await waitForIndexedContract(signer.provider!, poolAddress, () => pool.admin());
    if (![signer.address.toLowerCase(), idToEvmAddress(accountIdString).toLowerCase()].includes(admin.toLowerCase()))
      throw new Error("Configured signer is not the deployed pool owner");

    // 3 ── Associate the pool contract with WHBAR + USDX ─────────────────────────
    // Done via HAPI (signed by the pool's admin key = operator): a contract can
    // only authorize its own HTS associations when its key signs the transaction.
    console.log("\n3. Associating pool contract with WHBAR + USDX via HAPI…");
    for (const tokenId of [WHBAR_TOKEN_ID, usdxTokenId]) {
      try {
        const assocTx = await new TokenAssociateTransaction()
          .setAccountId(poolContractId)
          .setTokenIds([tokenId])
          .freezeWith(client)
          .sign(operatorKey);
        const assocReceipt = await (await assocTx.execute(client)).getReceipt(client);
        console.log(`   status: ${assocReceipt.status.toString()}`);
      } catch (error) {
        if (!String(error).includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) throw error;
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
    // A pending submission is resolved manually against the stored hash/ID before a
    // retry. Even a process crash after consensus must not duplicate a seed.
    for (const name of ["seedLiquidity", "seedFaucet", "mintDeficit"]) {
      if (record.steps?.[name]?.status === "pending") beginStep(record, name);
    }
    const needed =
      (record.steps?.seedLiquidity?.status === "complete" ? 0n : POOL_LIQUIDITY_USDX) +
      (record.steps?.seedFaucet?.status === "complete" ? 0n : FAUCET_SEED_USDX);
    const treasuryBalance: bigint = await usdx.balanceOf(signer.address);
    if (treasuryBalance < needed) {
      const deficit = needed - treasuryBalance;
      if (!beginStep(record, "mintDeficit"))
        throw new Error("Treasury changed after a prior mint; inspect balances before minting again");
      const mintTx = await new TokenMintTransaction()
        .setTokenId(usdxTokenId)
        .setAmount(Number(deficit))
        .freezeWith(client)
        .sign(operatorKey);
      record.steps!.mintDeficit.transactionId = mintTx.transactionId!.toString();
      saveDeployment(record);
      await (await mintTx.execute(client)).getReceipt(client);
      completeStep(record, "mintDeficit");
      console.log(`   minted ${deficit / 10n ** 6n} USDX to treasury (resumed run)`);
    }

    if (record.steps?.seedLiquidity?.status !== "complete") {
      await (await usdx.approve(poolAddress, POOL_LIQUIDITY_USDX, { gasLimit: 2_000_000 })).wait();
      if (beginStep(record, "seedLiquidity")) {
        const tx = await pool.supply(POOL_LIQUIDITY_USDX, { gasLimit: 2_000_000 });
        record.steps!.seedLiquidity.transactionHash = tx.hash;
        saveDeployment(record);
        await tx.wait();
        completeStep(record, "seedLiquidity");
        console.log(`   supplied ${POOL_LIQUIDITY_USDX / 10n ** 6n} USDX (deployer owns the supplier shares)`);
      }
    }

    if (record.steps?.seedFaucet?.status !== "complete") {
      await (await usdx.approve(poolAddress, FAUCET_SEED_USDX, { gasLimit: 2_000_000 })).wait();
      if (beginStep(record, "seedFaucet")) {
        const tx = await pool.fundFaucet(FAUCET_SEED_USDX, { gasLimit: 2_000_000 });
        record.steps!.seedFaucet.transactionHash = tx.hash;
        saveDeployment(record);
        await tx.wait();
        completeStep(record, "seedFaucet");
        console.log(`   funded faucet with ${FAUCET_SEED_USDX / 10n ** 6n} USDX`);
      }
    }

    // 5 ── Create the HCS activity topic ─────────────────────────────────────────
    let topicId = record.hcsTopicId;
    if (!topicId) {
      console.log("\n5. Creating HCS activity topic…");
      beginStep(record, "createTopic");
      const topicTx = await new TopicCreateTransaction()
        .setTopicMemo("HederaLendingTemplate verified activity feed")
        .setSubmitKey(operatorKey.publicKey)
        .setAdminKey(operatorKey.publicKey)
        .freezeWith(client)
        .sign(operatorKey);
      record.steps!.createTopic.transactionId = topicTx.transactionId!.toString();
      saveDeployment(record);
      const topicReceipt = await (await topicTx.execute(client)).getReceipt(client);
      topicId = topicReceipt.topicId!.toString();
      record.hcsTopicId = topicId;
      record.hcsRestricted = true;
      completeStep(record, "createTopic");
    }
    console.log(`   topic: ${topicId}`);

    // 6 ── Record for the frontend ───────────────────────────────────────────────
    saveDeployment(record);

    console.log("\n✅ Deployment complete");
    console.log(`   Pool contract: ${hashscanContract(poolAddress)}`);
    console.log(`   USDX token:    ${TESTNET.hashscan}/token/${usdxTokenId}`);
    console.log(`   HCS topic:     ${TESTNET.hashscan}/topic/${topicId}`);
    console.log(
      "\nNext: configure server-only Pyth/HCS env in packages/nextjs/.env.local (README), then npm run bootstrap.",
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
