import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { LendingPool, MockPyth, MockSaucerSwapRouter, MockUSDX, MockWHBAR } from "../typechain-types";

const ONE_HBAR = 10n ** 8n; // WHBAR/HBAR have 8 decimals
const ONE_USDX = 10n ** 6n; // USDX has 6 decimals
const PRICE_025 = 25_000_000n; // $0.25 with expo -8
const EXPO_MINUS_8 = -8;

// Mock SaucerSwap rate: USDX (6dp) per 1 WHBAR (8dp), scaled by 1e8.
// $0.25/HBAR => 0.25 USDX per WHBAR => rate = 250_000.
const RATE = 250_000n;

async function deployFixture() {
  const [admin, alice, bob] = await ethers.getSigners();

  const whbar = (await ethers.deployContract("MockWHBAR")) as unknown as MockWHBAR;
  const usdx = (await ethers.deployContract("MockUSDX")) as unknown as MockUSDX;
  const pyth = (await ethers.deployContract("MockPyth", [PRICE_025, EXPO_MINUS_8])) as unknown as MockPyth;
  const router = (await ethers.deployContract("MockSaucerSwapRouter", [
    await whbar.getAddress(),
    await usdx.getAddress(),
    RATE,
  ])) as unknown as MockSaucerSwapRouter;

  const pool = (await ethers.deployContract("LendingPool", [
    await whbar.getAddress(),
    await usdx.getAddress(),
    await pyth.getAddress(),
    ethers.ZeroHash, // any feed id — the mock ignores it
    await router.getAddress(),
  ])) as unknown as LendingPool;

  // The mock router needs a USDX float to pay swap proceeds (a real AMM has liquidity).
  await usdx.mint(await router.getAddress(), 10_000n * ONE_USDX);

  // Seed balances: alice is the supplier/liquidator, bob is the borrower.
  await usdx.mint(alice.address, 100_000n * ONE_USDX);
  await usdx.mint(bob.address, 1_000n * ONE_USDX);
  await usdx.mint(admin.address, 10_000n * ONE_USDX);

  return { admin, alice, bob, whbar, usdx, pyth, router, pool };
}

/** Wrap a price-update argument: empty means "use cached price" on the mock. */
const NO_UPDATE: string[] = [];

describe("LendingPool", () => {
  describe("collateral", () => {
    it("wraps deposited HBAR into WHBAR collateral", async () => {
      const { bob, pool, whbar } = await loadFixture(deployFixture);
      await expect(pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR }))
        .to.emit(pool, "CollateralDeposited")
        .withArgs(bob.address, 100n * ONE_HBAR);
      expect(await pool.collateralOf(bob.address)).to.equal(100n * ONE_HBAR);
      expect(await whbar.balanceOf(await pool.getAddress())).to.equal(100n * ONE_HBAR);
    });

    it("rejects zero-value deposits", async () => {
      const { bob, pool } = await loadFixture(deployFixture);
      await expect(pool.connect(bob).depositCollateral({ value: 0n })).to.be.revertedWith("no HBAR sent");
    });

    it("lets a borrower withdraw collateral when it leaves them healthy", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(10n * ONE_USDX, NO_UPDATE);

      // Withdrawing 40 leaves 60 HBAR ($15) — max borrow $11.25 >= $10 debt, still healthy.
      await expect(pool.connect(bob).withdrawCollateral(40n * ONE_HBAR, NO_UPDATE)).to.emit(
        pool,
        "CollateralWithdrawn",
      );
      expect(await pool.collateralOf(bob.address)).to.equal(60n * ONE_HBAR);
    });

    it("blocks a withdrawal that breaks the collateral factor", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(10n * ONE_USDX, NO_UPDATE);

      await expect(pool.connect(bob).withdrawCollateral(50n * ONE_HBAR + 1n, NO_UPDATE))
        .to.be.revertedWithCustomError(pool, "InsufficientCollateral");
    });
  });

  describe("supply / borrow", () => {
    it("credits suppliers and lets them withdraw", async () => {
      const { alice, pool, usdx } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 5_000n * ONE_USDX);
      await expect(pool.connect(alice).supply(5_000n * ONE_USDX)).to.emit(pool, "Supplied");
      expect(await pool.supplyBalanceOf(alice.address)).to.equal(5_000n * ONE_USDX);
      await expect(pool.connect(alice).withdrawSupply(5_000n * ONE_USDX)).to.emit(pool, "SupplyWithdrawn");
      expect(await pool.supplyBalanceOf(alice.address)).to.equal(0n);
    });

    it("enforces the 75% collateral factor on borrows", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });

      // 100 HBAR * $0.25 * 75% = $18.75 max borrow
      await pool.connect(bob).borrow(18_750_000n, NO_UPDATE);
      expect(await pool.borrowBalanceOf(bob.address)).to.equal(18_750_000n);

      await expect(pool.connect(bob).borrow(1n, NO_UPDATE)).to.be.revertedWithCustomError(
        pool,
        "InsufficientCollateral",
      );
    });

    it("reverts borrows with no collateral", async () => {
      const { alice, pool, usdx } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await expect(pool.connect(alice).borrow(1n * ONE_USDX, NO_UPDATE)).to.be.revertedWithCustomError(
        pool,
        "InsufficientCollateral",
      );
    });

    it("handles partial and full repayments", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(10n * ONE_USDX, NO_UPDATE);

      await usdx.connect(bob).approve(await pool.getAddress(), 10n * ONE_USDX);
      await expect(pool.connect(bob).repay(4n * ONE_USDX)).to.emit(pool, "Repaid");
      expect(await pool.borrowBalanceOf(bob.address)).to.equal(6n * ONE_USDX);
      await pool.connect(bob).repay(100n * ONE_USDX); // overpay clamps to owed
      expect(await pool.borrowBalanceOf(bob.address)).to.equal(0n);
    });
  });

  describe("interest accrual", () => {
    it("grows borrows and supplies after time passes", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(10n * ONE_USDX, NO_UPDATE);

      const borrowBefore = await pool.borrowBalanceOf(bob.address);
      const supplyBefore = await pool.supplyBalanceOf(alice.address);

      await time.increase(31_536_000); // +1 year
      await pool.accrue();

      const borrowAfter = await pool.borrowBalanceOf(bob.address);
      const supplyAfter = await pool.supplyBalanceOf(alice.address);

      // ~24% APY at 0.1% utilization → debt grows, suppliers earn (minus 10% reserve).
      expect(borrowAfter).to.be.gt(borrowBefore);
      expect(supplyAfter).to.be.gt(supplyBefore);
      expect(borrowAfter - borrowBefore).to.be.gt(supplyAfter - supplyBefore);
    });

    it("splits interest between suppliers and reserves", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(10n * ONE_USDX, NO_UPDATE);

      await time.increase(31_536_000);
      await pool.accrue();

      const totalBorrow = await pool.totalBorrow();
      const totalSupply = await pool.totalSupply();
      const reserves = await pool.totalReserves();
      const interest = totalBorrow - 10n * ONE_USDX;
      // Suppliers earn ~90% of interest, reserves keep ~10% (loose bounds for rounding).
      const supplierGain = totalSupply - 10_000n * ONE_USDX;
      expect(supplierGain > (interest * 88n) / 100n).to.equal(true);
      expect(supplierGain < (interest * 92n) / 100n).to.equal(true);
      expect(reserves > interest / 11n).to.equal(true);
      expect(reserves < interest / 9n).to.equal(true);
    });
  });

  describe("pyth price updates", () => {
    it("caches the fresh price and refunds excess fee", async () => {
      const { pool } = await loadFixture(deployFixture);
      // Mock update fee is 0; 1 wei sent must be refunded, price cached.
      const tx = pool.updatePrice(["0x1234"], { value: 1n });
      await expect(tx).to.emit(pool, "PriceUpdated");
      expect(await pool.latestPrice18()).to.equal(PRICE_025 * 10n ** 10n); // $0.25e18
    });
  });

  describe("liquidation", () => {
    async function unhealthyFixture() {
      const f = await loadFixture(deployFixture);
      const { alice, bob, usdx, pool, pyth } = f;
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(18n * ONE_USDX, NO_UPDATE);
      // HBAR/USD drops $0.25 → $0.20: collateral $20, threshold $16 < debt $18.
      await pyth.setPrice(20_000_000n);
      return f;
    }

    it("flags underwater positions as liquidatable", async () => {
      const { bob, pool } = await unhealthyFixture();
      const price = 20_000_000n * 10n ** 10n;
      expect(await pool.isLiquidatable(bob.address, price)).to.equal(true);
    });

    it("repays debt, seizes collateral and pays the liquidator swap proceeds", async () => {
      const { alice, bob, usdx, pool, router } = await unhealthyFixture();
      const price = 20_000_000n * 10n ** 10n;
      const borrowBefore = await pool.borrowBalanceOf(bob.address);
      const collateralBefore = await pool.collateralOf(bob.address);
      const balanceBefore = await usdx.balanceOf(alice.address);

      // Seized = $10 * 1.05 / $0.20 = 52.5 WHBAR; mock pool rate $0.25 → 13.125 USDX recovered.
      const minOut = 13n * ONE_USDX;
      const deadline = BigInt(await time.latest()) + 300n;
      await usdx.connect(alice).approve(await pool.getAddress(), 10n * ONE_USDX);
      await expect(
        pool.connect(alice).liquidate(bob.address, 10n * ONE_USDX, minOut, deadline, NO_UPDATE),
      ).to.emit(pool, "Liquidated");

      expect(await pool.borrowBalanceOf(bob.address)).to.equal(borrowBefore - 10n * ONE_USDX);
      expect(await pool.collateralOf(bob.address)).to.equal(collateralBefore - (525n * ONE_HBAR) / 10n);
      // Liquidator: -10 USDX repaid, +13.125 USDX swap proceeds.
      const profit = (await usdx.balanceOf(alice.address)) - balanceBefore;
      expect(profit).to.equal((13125n * ONE_USDX) / 1000n - 10n * ONE_USDX);

      // The mock router actually received and swapped the WHBAR.
      const amounts = await router.getAmountsOut((525n * ONE_HBAR) / 10n, []);
      expect(amounts[1]).to.equal((13125n * ONE_USDX) / 1000n);
    });

    it("reverts when the position is healthy", async () => {
      const { alice, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(alice).approve(await pool.getAddress(), 10_000n * ONE_USDX);
      await pool.connect(alice).supply(10_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(10n * ONE_USDX, NO_UPDATE);

      const price = PRICE_025 * 10n ** 10n;
      await usdx.connect(alice).approve(await pool.getAddress(), 10n * ONE_USDX);
      const deadline = BigInt(await time.latest()) + 300n;
      await expect(
        pool.connect(alice).liquidate(bob.address, 10n * ONE_USDX, 0n, deadline, NO_UPDATE),
      ).to.be.revertedWithCustomError(pool, "HealthyPosition");
    });

    it("caps the seizure at the borrower's remaining collateral", async () => {
      const { alice, bob, usdx, pool, pyth } = await unhealthyFixture();
      // Push the price down further: debt $18 vs threshold $12 (100 HBAR * $0.15 * 0.8).
      await pyth.setPrice(15_000_000n);
      const price = 15_000_000n * 10n ** 10n;

      const deadline = BigInt(await time.latest()) + 300n;
      await usdx.connect(alice).approve(await pool.getAddress(), 18n * ONE_USDX);
      await pool.connect(alice).liquidate(bob.address, 18n * ONE_USDX, 0n, deadline, NO_UPDATE);
      expect(await pool.collateralOf(bob.address)).to.equal(0n);
    });
  });

  describe("faucet", () => {
    it("pays out with a cooldown and a budget", async () => {
      const { admin, bob, usdx, pool } = await loadFixture(deployFixture);
      await usdx.connect(admin).approve(await pool.getAddress(), 1_000n * ONE_USDX);
      await pool.connect(admin).fundFaucet(1_000n * ONE_USDX);

      await expect(pool.connect(bob).claimFaucet()).to.emit(pool, "FaucetClaimed");
      expect(await usdx.balanceOf(bob.address)).to.equal(1_250n * ONE_USDX); // 1000 minted + 250 faucet
      expect(await pool.faucetBudget()).to.equal(750n * ONE_USDX);

      await expect(pool.connect(bob).claimFaucet()).to.be.revertedWith("faucet cooldown");
    });

    it("only the admin can fund or disable it", async () => {
      const { alice, admin, pool } = await loadFixture(deployFixture);
      await expect(pool.connect(alice).setFaucetEnabled(false)).to.be.revertedWith("not admin");
      await pool.connect(admin).setFaucetEnabled(false);
      expect(await pool.faucetEnabled()).to.equal(false);
    });
  });
});
