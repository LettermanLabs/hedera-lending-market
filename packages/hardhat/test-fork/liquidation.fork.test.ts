/**
 * Read-only mainnet checks and a local liquidation simulation:
 *
 * 1. Read the deployed SaucerSwap mainnet factory, pair and router through a
 *    provider without a signer. Assert its exact quote from same-block reserves.
 * 2. Transfer real HTS asset balances on a local mainnet fork into an independently
 *    implemented MIT constant-product test harness, then exercise LendingPool's
 *    liquidation, collateral, cash and debt accounting against that harness.
 *
 * No mainnet transactions are submitted. The local swap uses the test harness,
 * not canonical SaucerSwap contracts. The WHBAR minting path is replaced by a
 * prefunded conversion float, and Pyth prices are mocked.
 *
 * Unit convention on the fork: 1 wei = 1 tinybar, matching how Hedera's EVM
 * exposes msg.value (1 HBAR = 1e8 tinybar).
 *
 * Run: npm run test:fork
 */
import { expect } from "chai";
import type { Contract } from "ethers";
import { ethers, network } from "hardhat";
import { ConstantProductHarness, NativeTokenFloat, LendingPool, MockPyth } from "../typechain-types";

const lz = (num: number | bigint) => `0x${BigInt(num).toString(16).padStart(40, "0")}` as `0x${string}`;

const MAINNET = {
  // Official deployment IDs, verified 2026-09-22:
  // https://docs.saucerswap.finance/developers/contracts
  factory: lz(1062784),
  router: lz(3045981),
  whbar: lz(1456986), // WHBAR HTS token
  usdc: lz(456858), // USDC native HTS token
  pair: lz(1462797), // SaucerSwap WHBAR/USDC V1 pair used to fund the local fork
};

const HBAR_UNITS = 10n ** 8n;
const ONE_USDC = 10n ** 6n;
const NO_UPDATE: string[] = [];

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function name() view returns (string)",
];

async function impersonateWithGas(address: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [address, "0x56BC75E2D63100000"], // Gas balance in the fork's native units
  });
  return ethers.getSigner(address);
}

describe("Deployed SaucerSwap reads and local fork liquidation simulation", function () {
  this.timeout(300_000);

  it("verifies the deployed mainnet router quote against same-block pair reserves (read-only)", async () => {
    const provider = new ethers.JsonRpcProvider("https://mainnet.hashio.io/api", 295, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    try {
      const blockTag = await provider.getBlockNumber();
      const factory = new ethers.Contract(
        MAINNET.factory,
        ["function getPair(address,address) view returns (address)"],
        provider,
      );
      const pairAddress = (await factory.getPair(MAINNET.whbar, MAINNET.usdc, { blockTag })) as string;
      expect(pairAddress).not.to.equal(ethers.ZeroAddress);
      const pair = new ethers.Contract(
        pairAddress,
        [
          "function token0() view returns (address)",
          "function token1() view returns (address)",
          "function getReserves() view returns (uint112,uint112,uint32)",
        ],
        provider,
      );
      const router = new ethers.Contract(
        MAINNET.router,
        ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
        provider,
      );
      const [token0, token1, reserves, amounts] = await Promise.all([
        pair.token0({ blockTag }),
        pair.token1({ blockTag }),
        pair.getReserves({ blockTag }),
        router.getAmountsOut(HBAR_UNITS, [MAINNET.whbar, MAINNET.usdc], { blockTag }),
      ]);
      expect((token0 as string).toLowerCase()).to.equal(MAINNET.usdc);
      expect((token1 as string).toLowerCase()).to.equal(MAINNET.whbar);
      const stableReserve = reserves[0] as bigint;
      const hbarReserve = reserves[1] as bigint;
      expect(stableReserve).to.be.gt(0n);
      expect(hbarReserve).to.be.gt(0n);
      const feeAdjustedInput = HBAR_UNITS * 997n;
      const independentlyCalculated = (feeAdjustedInput * stableReserve) / (hbarReserve * 1000n + feeAdjustedInput);
      expect(amounts[0]).to.equal(HBAR_UNITS);
      expect(amounts[1]).to.equal(independentlyCalculated);
      console.log(
        `   read-only mainnet block ${blockTag}: router 0.0.3045981 quotes 1 WHBAR -> ${amounts[1]} USDC units`,
      );
    } finally {
      provider.destroy();
    }
  });

  it("settles an underwater position through the local MIT harness using forked HTS balances", async () => {
    const [, supplier, borrower, liquidator] = await ethers.getSigners();

    // Copy HTS balances within the local fork.
    const whale = await impersonateWithGas(MAINNET.pair);
    const usdc = new ethers.Contract(MAINNET.usdc, ERC20_ABI, whale);
    const whbarToken = new ethers.Contract(MAINNET.whbar, ERC20_ABI, whale);

    const nativeFloat = (await ethers.deployContract("NativeTokenFloat", [
      MAINNET.whbar,
    ])) as unknown as NativeTokenFloat;
    const router = (await ethers.deployContract("ConstantProductHarness", [
      MAINNET.whbar,
      MAINNET.usdc,
      await nativeFloat.getAddress(),
    ])) as unknown as ConstantProductHarness;
    const harnessAddress = await router.getAddress();
    const usdcReserve = 200_000n * ONE_USDC;
    const whbarReserve = 1_000_000n * HBAR_UNITS;
    await (await usdc.transfer(harnessAddress, usdcReserve)).wait();
    await (await whbarToken.transfer(harnessAddress, whbarReserve)).wait();
    await (await router.seed()).wait();
    const [r0, r1] = await router.getReserves();
    console.log(`   local harness seeded with forked balances: ${r1} WHBAR / ${r0} USDC`);
    await (await whbarToken.transfer(await nativeFloat.getAddress(), whbarReserve)).wait();

    // Deploy the pool with forked HTS assets and the local swap harness.
    const pyth = (await ethers.deployContract("MockPyth", [10_000_000, -8])) as unknown as MockPyth; // $0.10
    const pool = (await ethers.deployContract("LendingPool", [
      MAINNET.whbar,
      MAINNET.usdc,
      await pyth.getAddress(),
      ethers.ZeroHash,
      await router.getAddress(),
    ])) as unknown as LendingPool;
    const poolAddress = await pool.getAddress();
    console.log(`   pool: ${poolAddress}`);

    try {
      await (await pool.associateTokens()).wait();
    } catch {
      // The fork may not emulate 0x167; subsequent transfers check token usability.
    }

    // Fund test accounts from the forked pair reserves.
    await (await usdc.transfer(supplier.address, 20_000n * ONE_USDC)).wait();
    await (await usdc.transfer(liquidator.address, 100n * ONE_USDC)).wait();

    // Supply USDC.
    const usdcAsSupplier = usdc.connect(supplier) as unknown as Contract;
    await (await usdcAsSupplier.approve(poolAddress, 20_000n * ONE_USDC)).wait();
    await (await pool.connect(supplier).supply(10_000n * ONE_USDC)).wait();
    console.log("   supplied 10,000 USDC");

    // Borrow against HBAR collateral at $0.10.
    await (await pool.connect(borrower).depositCollateral({ value: 100n * HBAR_UNITS })).wait();
    await (await pool.connect(borrower).borrow(6n * ONE_USDC, NO_UPDATE)).wait();
    console.log("   borrowed 6 USDC against 100 HBAR collateral");

    // At $0.07, the position falls below the liquidation threshold.
    await (await pyth.setPrice(7_000_000)).wait(); // $0.07
    const price = 7_000_000n * 10n ** 10n;
    expect(await pool.isLiquidatable(borrower.address, price)).to.equal(true);

    // Repay USDC and swap the seized HBAR through the local harness.
    const collateralBefore = await pool.collateralOf(borrower.address);
    const usdcAsLiquidator = usdc.connect(liquidator) as unknown as Contract;
    // Allow the fork account to close the debt, including interest accrued
    // between the quote, approval, and liquidation blocks.
    await (await usdcAsLiquidator.approve(poolAddress, ethers.MaxUint256)).wait();
    const [, quotedSeizure] = await pool.previewLiquidation(borrower.address, ethers.MaxUint256, price);
    const quote = await router.getAmountsOut(quotedSeizure, [MAINNET.whbar, MAINNET.usdc]);
    const minOut = quote[1] - quote[1] / 33n; // ~3% slippage
    console.log(`   quoting ${quotedSeizure} HBAR-units, AMM quotes ${quote[1]} USDC`);

    const balanceBefore = (await usdc.balanceOf(liquidator.address)) as bigint;
    const poolCashBefore = (await usdc.balanceOf(poolAddress)) as bigint;
    const sharesBefore = await pool.borrowScaled(borrower.address);
    const [usdcBefore, whbarBefore] = await router.getReserves();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest!.timestamp) + 300n;

    const tx = await pool
      .connect(liquidator)
      .liquidate(borrower.address, ethers.MaxUint256, minOut, deadline, NO_UPDATE);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "Liquidated");
    expect(event, "liquidation settlement event").not.to.equal(undefined);
    const debt = event!.args.repaid as bigint;
    const seized = event!.args.whbarSeized as bigint;
    const recovered = event!.args.usdxRecovered as bigint;

    const balanceAfter = (await usdc.balanceOf(liquidator.address)) as bigint;
    const collateralAfter = await pool.collateralOf(borrower.address);

    // The mocked $0.07 price and seeded $0.20 ratio produce a profitable liquidation;
    // neither is a mainnet price observation.
    // Check debt and seizure at the execution index, which includes pending interest.
    const executionDebt = (sharesBefore * (await pool.borrowIndex()) + 10n ** 18n - 1n) / 10n ** 18n;
    expect(debt).to.equal(executionDebt);
    const expectedSeizure = (((debt * 10n ** 12n * 105n) / 100n) * HBAR_UNITS) / price;
    expect(seized).to.equal(expectedSeizure);
    expect(collateralBefore - collateralAfter).to.equal(seized);
    // Independently calculate exact constant-product execution from reserves.
    const inputAfterFee = seized * 997n;
    const expectedOutput = (inputAfterFee * usdcBefore) / (whbarBefore * 1000n + inputAfterFee);
    expect(recovered).to.equal(expectedOutput);
    expect(balanceAfter - balanceBefore).to.equal(recovered - debt);
    expect(await usdc.balanceOf(poolAddress)).to.equal(poolCashBefore + debt);
    const [usdcAfter, whbarAfter] = await router.getReserves();
    expect(usdcBefore - usdcAfter).to.equal(recovered);
    expect(whbarAfter - whbarBefore).to.equal(seized);
    expect(await pool.borrowScaled(borrower.address)).to.equal(0n);
    expect(await pool.borrowBalanceOf(borrower.address)).to.equal(0n);
    expect(recovered).to.be.gte(minOut);
    expect(recovered).to.be.gt(debt); // the liquidation incentive
    console.log(
      `   liquidator profit: ${(recovered - debt) / ONE_USDC} USDC — settled through ` +
        `the local constant-product harness using forked WHBAR/USDC balances`,
    );
  });
});
