/**
 * Forked-mainnet liquidation test — the SaucerSwap evidence.
 *
 * SaucerSwap's legacy testnet deployment can no longer create pairs (see README),
 * so this test forks Hedera MAINNET and settles a real liquidation against the
 * reserves of the REAL SaucerSwap WHBAR/USDC V1 pool (0.0.1462797: ~2.85M WHBAR /
 * ~268k USDC at fork time), which are transferred on-fork to seed the pair.
 *
 * The AMM is the canonical SaucerSwap V1 implementation — vendored verbatim from
 * saucerswaplabs-core with only the HTS-coupled parts adapted for the fork's
 * emulation (see contracts/fork/*.sol headers). The pool's oracle is a mock (the
 * oracle leg has its own unit tests).
 *
 * Unit convention on the fork: 1 wei = 1 tinybar, matching how Hedera's EVM
 * exposes msg.value (1 HBAR = 1e8 tinybar).
 *
 * Run: npm run test:fork
 */
import { expect } from "chai";
import type { Contract } from "ethers";
import { ethers, network } from "hardhat";
import { ForkPair, ForkSwapRouter, ForkWHBARWrapper, LendingPool, MockPyth } from "../typechain-types";

const lz = (num: number | bigint) => `0x${BigInt(num).toString(16).padStart(40, "0")}` as `0x${string}`;

const MAINNET = {
  whbar: lz(1456986), // WHBAR HTS token
  usdc: lz(456858), // USDC native HTS token
  pair: lz(1462797), // real SaucerSwap WHBAR/USDC V1 pair — the reserve whale
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
    params: [address, "0x56BC75E2D63100000"], // 100 HBAR for gas
  });
  return ethers.getSigner(address);
}

describe("Liquidation against SaucerSwap mainnet reserves (fork)", function () {
  this.timeout(300_000);

  it("settles an underwater position through the WHBAR/USDC AMM", async () => {
    const [deployer, supplier, borrower, liquidator] = await ethers.getSigners();

    // ── Seed the canonical AMM with the REAL pair's reserves ──────────────────
    const whale = await impersonateWithGas(MAINNET.pair);
    const usdc = new ethers.Contract(MAINNET.usdc, ERC20_ABI, whale);
    const whbarToken = new ethers.Contract(MAINNET.whbar, ERC20_ABI, whale);

    const pair = (await ethers.deployContract("ForkPair")) as unknown as ForkPair;
    await (await pair.initialize(MAINNET.usdc, MAINNET.whbar)).wait(); // token0=USDC < token1=WHBAR
    const pairAddress = await pair.getAddress();

    const usdcReserve = 200_000n * ONE_USDC;
    const whbarReserve = 1_000_000n * HBAR_UNITS;
    await (await usdc.transfer(pairAddress, usdcReserve)).wait();
    await (await whbarToken.transfer(pairAddress, whbarReserve)).wait();
    await (await pair.mint(deployer.address)).wait();
    const [r0, r1] = await pair.getReserves();
    console.log(`   pair seeded from real reserves: ${r1} WHBAR / ${r0} USDC`);

    // ── WHBAR wrapper float + router (mirrors SaucerSwapV1RouterV3 flow) ──────
    const wrapper = (await ethers.deployContract("ForkWHBARWrapper", [MAINNET.whbar])) as unknown as ForkWHBARWrapper;
    await (await whbarToken.transfer(await wrapper.getAddress(), whbarReserve)).wait();

    const router = (await ethers.deployContract("ForkSwapRouter", [
      pairAddress,
      MAINNET.whbar,
      await wrapper.getAddress(),
    ])) as unknown as ForkSwapRouter;

    // ── Deploy the pool against the real WHBAR/USDC + fork router ─────────────
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
      // 0x167 not emulated — transfers below will confirm whether it matters
    }

    // ── Fund actors from the real reserves ────────────────────────────────────
    await (await usdc.transfer(supplier.address, 20_000n * ONE_USDC)).wait();
    await (await usdc.transfer(liquidator.address, 100n * ONE_USDC)).wait();

    // ── Supply USDC ────────────────────────────────────────────────────────────
    const usdcAsSupplier = usdc.connect(supplier) as unknown as Contract;
    await (await usdcAsSupplier.approve(poolAddress, 20_000n * ONE_USDC)).wait();
    await (await pool.connect(supplier).supply(10_000n * ONE_USDC)).wait();
    console.log("   supplied 10,000 USDC");

    // ── Borrow against HBAR collateral at $0.10 ───────────────────────────────
    await (await pool.connect(borrower).depositCollateral({ value: 100n * HBAR_UNITS })).wait();
    await (await pool.connect(borrower).borrow(6n * ONE_USDC, NO_UPDATE)).wait();
    console.log("   borrowed 6 USDC against 100 HBAR collateral");

    // ── HBAR drops to $0.07 → position is underwater ──────────────────────────
    await (await pyth.setPrice(7_000_000)).wait(); // $0.07
    const price = 7_000_000n * 10n ** 10n;
    expect(await pool.isLiquidatable(borrower.address, price)).to.equal(true);

    // ── Liquidate: repay 6 USDC, pool swaps seized HBAR through the AMM ───────
    const debt = await pool.borrowBalanceOf(borrower.address);
    const collateralBefore = await pool.collateralOf(borrower.address);

    const seizeUsd18 = (debt * 10n ** 12n * 105n) / 100n;
    const seized = (seizeUsd18 * 10n ** 8n) / price;
    const quote = await router.getAmountsOut(seized, [MAINNET.whbar, MAINNET.usdc]);
    const minOut = (quote[1] as bigint) - (quote[1] as bigint) / 33n; // ~3% slippage
    console.log(`   seizing ${seized} HBAR-units, AMM quotes ${quote[1]} USDC`);

    const usdcAsLiquidator = usdc.connect(liquidator) as unknown as Contract;
    await (await usdcAsLiquidator.approve(poolAddress, debt)).wait();

    const balanceBefore = (await usdc.balanceOf(liquidator.address)) as bigint;
    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest!.timestamp) + 300n;

    await expect(pool.connect(liquidator).liquidate(borrower.address, debt, minOut, deadline, NO_UPDATE)).to.emit(
      pool,
      "Liquidated",
    );

    const balanceAfter = (await usdc.balanceOf(liquidator.address)) as bigint;
    const recovered = balanceAfter - balanceBefore + debt; // they paid `debt` into the pool
    const collateralAfter = await pool.collateralOf(borrower.address);

    // NOTE: the profit looks large because the mock oracle ($0.07) diverges from
    // the seeded pool rate (~$0.20) — the same arbitrage a real liquidator earns
    // whenever the AMM lags the oracle. The assertions verify the swap itself.

    // ── Assertions ─────────────────────────────────────────────────────────────
    expect(collateralBefore - collateralAfter).to.equal(seized);
    expect(recovered).to.be.gte(minOut);
    expect(recovered).to.be.gt(debt); // the liquidation incentive
    console.log(
      `   liquidator profit: ${(recovered - debt) / ONE_USDC} USDC — settled through ` +
        `the SaucerSwap V1 AMM against real WHBAR/USDC reserves`,
    );
  });
});
