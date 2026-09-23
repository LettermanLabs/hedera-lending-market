import { expect } from "chai";
import { ethers, network } from "hardhat";
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
    it("accepts native HBAR collateral", async () => {
      const { bob, pool } = await loadFixture(deployFixture);
      await expect(pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR }))
        .to.emit(pool, "CollateralDeposited")
        .withArgs(bob.address, 100n * ONE_HBAR);
      expect(await pool.collateralOf(bob.address)).to.equal(100n * ONE_HBAR);
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

      await expect(pool.connect(bob).withdrawCollateral(50n * ONE_HBAR + 1n, NO_UPDATE)).to.be.revertedWithCustomError(
        pool,
        "InsufficientCollateral",
      );
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

      await usdx.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);
      await expect(pool.connect(bob).repay(4n * ONE_USDX)).to.emit(pool, "Repaid");
      // Interest also accrues during the approval/repayment blocks. A partial
      // repayment can leave one unit of conservative share-rounding dust.
      expect(await pool.borrowBalanceOf(bob.address)).to.be.within(6n * ONE_USDX, 6n * ONE_USDX + 2n);
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

      // ~2.038% annual rate at 0.1% utilization → debt grows, suppliers earn.
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
      const borrowBefore = await pool.borrowBalanceOf(bob.address);
      const collateralBefore = await pool.collateralOf(bob.address);
      const balanceBefore = await usdx.balanceOf(alice.address);

      // Seized = $10 * 1.05 / $0.20 = 52.5 WHBAR; mock pool rate $0.25 → 13.125 USDX recovered.
      const minOut = 13n * ONE_USDX;
      const deadline = BigInt(await time.latest()) + 300n;
      await usdx.connect(alice).approve(await pool.getAddress(), 10n * ONE_USDX);
      await expect(pool.connect(alice).liquidate(bob.address, 10n * ONE_USDX, minOut, deadline, NO_UPDATE)).to.emit(
        pool,
        "Liquidated",
      );

      expect(await pool.borrowBalanceOf(bob.address)).to.be.within(
        borrowBefore - 10n * ONE_USDX,
        borrowBefore - 10n * ONE_USDX + 2n,
      );
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

  describe("accounting regressions", () => {
    async function activeFixture() {
      const f = await deployFixture();
      const { alice, bob, pool, usdx } = f;
      await usdx.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdx.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).supply(20n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(15n * ONE_USDX, NO_UPDATE);
      return f;
    }

    async function assertAccounting(f: Awaited<ReturnType<typeof deployFixture>>, accounts: string[]) {
      await f.pool.accrue();
      const supplyShares = await Promise.all(accounts.map((account) => f.pool.supplyScaled(account)));
      const borrowShares = await Promise.all(accounts.map((account) => f.pool.borrowScaled(account)));
      expect(await f.pool.totalSupplyScaled()).to.equal(supplyShares.reduce((a, b) => a + b, 0n));
      expect(await f.pool.totalBorrowScaled()).to.equal(borrowShares.reduce((a, b) => a + b, 0n));
      // Every accounting unit is backed by pool cash or outstanding debt. Faucet
      // funds are separate liabilities; neither rounding nor a write-off loses units.
      const assets = (await f.usdx.balanceOf(await f.pool.getAddress())) + (await f.pool.totalBorrow());
      const liabilities = (await f.pool.totalSupply()) + (await f.pool.totalReserves()) + (await f.pool.faucetBudget());
      expect(assets).to.equal(liabilities);
    }

    it("rejects a collateral withdrawal that only looks healthy before pending interest", async () => {
      const { bob, pool, pyth } = await loadFixture(activeFixture);
      await time.increase(15_768_000);
      await pyth.setPrice(PRICE_025);
      expect(await pool.borrowBalanceOf(bob.address)).to.be.gt(17n * ONE_USDX);
      await expect(pool.connect(bob).withdrawCollateral(20n * ONE_HBAR, NO_UPDATE)).to.be.revertedWithCustomError(
        pool,
        "InsufficientCollateral",
      );
      expect(await pool.collateralOf(bob.address)).to.equal(100n * ONE_HBAR);
    });

    it("charges shares for the smallest borrow and withdrawal after indexes grow", async () => {
      const f = await loadFixture(activeFixture);
      const { alice, bob, pool, pyth, usdx } = f;
      await time.increase(15_768_000);
      await pyth.setPrice(PRICE_025);
      await pool.accrue();
      const supplyShares = await pool.supplyScaled(alice.address);
      const supplierCash = await usdx.balanceOf(alice.address);
      await pool.connect(alice).withdrawSupply(1n);
      expect(await pool.supplyScaled(alice.address)).to.be.lt(supplyShares);
      expect(await usdx.balanceOf(alice.address)).to.equal(supplierCash + 1n);
      const debtShares = await pool.borrowScaled(bob.address);
      await pool.connect(bob).borrow(1n, NO_UPDATE);
      expect(await pool.borrowScaled(bob.address)).to.be.gt(debtShares);
      await expect(pool.connect(bob).repay(1n)).to.be.revertedWith("amount too small");
      await assertAccounting(f, [alice.address, bob.address]);
    });

    it("clears every debt share on full repayment after accrued interest", async () => {
      const f = await loadFixture(activeFixture);
      const { alice, bob, pool, pyth } = f;
      await time.increase(12_345_678);
      await pyth.setPrice(PRICE_025);
      await pool.connect(bob).repay(ethers.MaxUint256);
      expect(await pool.borrowScaled(bob.address)).to.equal(0n);
      expect(await pool.borrowBalanceOf(bob.address)).to.equal(0n);
      expect(await pool.totalBorrowScaled()).to.equal(0n);
      await pool.connect(bob).withdrawCollateral(100n * ONE_HBAR, NO_UPDATE);
      const balance = await pool.supplyBalanceOf(alice.address);
      await pool.connect(alice).withdrawSupply(balance);
      expect(await pool.supplyScaled(alice.address)).to.equal(0n);
      await assertAccounting(f, [alice.address, bob.address]);
    });

    it("does not erase interest when anyone accrues at short intervals", async () => {
      const { pool } = await loadFixture(activeFixture);
      const snapshot = await network.provider.send("evm_snapshot");
      const start = await time.latest();
      for (let i = 1; i <= 60; i++) {
        await time.setNextBlockTimestamp(start + i);
        await pool.accrue();
      }
      const frequent = await pool.totalBorrow();
      await network.provider.send("evm_revert", [snapshot]);
      await time.setNextBlockTimestamp(start + 60);
      await pool.accrue();
      const once = await pool.totalBorrow();
      expect(frequent).to.be.gte(once);
      expect(frequent - once).to.be.lte(1n); // negligible compounding over one minute
      expect(once).to.be.gt(15n * ONE_USDX);
    });

    it("maintains aggregate shares and asset conservation across multiple accounts and loss", async () => {
      const f = await loadFixture(deployFixture);
      const { admin, alice, bob, pool, pyth, usdx } = f;
      const accounts = [admin.address, alice.address, bob.address];
      await usdx.connect(admin).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdx.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdx.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).supply(1_000_000_003n);
      await pool.connect(admin).supply(500_000_009n);
      await pool.connect(admin).fundFaucet(1_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(18_000_001n, NO_UPDATE);
      await pool.connect(admin).depositCollateral({ value: 200n * ONE_HBAR });
      await pool.connect(admin).borrow(7_000_003n, NO_UPDATE);
      await assertAccounting(f, accounts);
      await time.increase(123_456);
      await pool.connect(alice).supply(3_000_007n);
      await pool.connect(alice).withdrawSupply(1_000_003n);
      await pool.connect(bob).repay(1_000_009n);
      await assertAccounting(f, accounts);
      await pyth.setPrice(15_000_000n);
      await pool
        .connect(alice)
        .liquidate(bob.address, ethers.MaxUint256, 0n, BigInt(await time.latest()) + 300n, NO_UPDATE);
      expect(await pool.borrowScaled(bob.address)).to.equal(0n);
      expect(await pool.collateralOf(bob.address)).to.equal(0n);
      await assertAccounting(f, accounts);
      await pool.connect(bob).claimFaucet();
      await assertAccounting(f, accounts);
      await pool.connect(admin).repay(ethers.MaxUint256);
      await pool.connect(alice).withdrawSupply(await pool.supplyBalanceOf(alice.address));
      await pool.connect(admin).withdrawSupply(await pool.supplyBalanceOf(admin.address));
      await assertAccounting(f, accounts);
    });

    it("uses reserves before suppliers and stops interest on exhausted debt", async () => {
      const f = await loadFixture(activeFixture);
      const { alice, bob, pool, pyth } = f;
      await time.increase(31_536_000);
      await pyth.setPrice(20_300_000n); // $20.30 collateral, debt ~19.575, reserves ~0.4575
      await pool.accrue();
      const supplyBefore = await pool.supplyBalanceOf(alice.address);
      const reservesBefore = await pool.totalReserves();
      const [pay, seizure] = await pool.previewLiquidation(bob.address, ethers.MaxUint256, 203_000_000_000_000_000n);
      expect(pay).to.equal(19_333_334n);
      expect(seizure).to.equal(100n * ONE_HBAR);
      const tx = await pool
        .connect(alice)
        .liquidate(bob.address, ethers.MaxUint256, 0n, BigInt(await time.latest()) + 300n, NO_UPDATE);
      const receipt = await tx.wait();
      const resolved = receipt!.logs
        .map((log) => {
          try {
            return pool.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((log) => log?.name === "BadDebtResolved")!;
      expect(resolved.args.reservesUsed).to.equal(resolved.args.debt);
      expect(resolved.args.supplierLoss).to.equal(0n);
      expect(await pool.totalReserves()).to.be.lt(reservesBefore);
      expect(await pool.supplyBalanceOf(alice.address)).to.be.gte(supplyBefore);
      expect(await pool.borrowScaled(bob.address)).to.equal(0n);
      const supplyAfter = await pool.totalSupply();
      const reservesAfter = await pool.totalReserves();
      await time.increase(31_536_000);
      await pool.accrue();
      expect(await pool.totalBorrow()).to.equal(0n);
      expect(await pool.totalSupply()).to.equal(supplyAfter);
      expect(await pool.totalReserves()).to.equal(reservesAfter);
      await assertAccounting(f, [alice.address, bob.address]);
    });

    it("shares uncovered bad debt proportionally and preserves recapitalization accounting", async () => {
      const f = await loadFixture(deployFixture);
      const { admin, alice, bob, pool, pyth, usdx } = f;
      await usdx.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdx.connect(admin).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).supply(1_000n * ONE_USDX);
      await pool.connect(admin).supply(500n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await pool.connect(bob).borrow(18n * ONE_USDX, NO_UPDATE);
      await time.increase(31_536_000);
      await pyth.setPrice(15_000_000n);
      await pool.accrue();
      const aliceBefore = await pool.supplyBalanceOf(alice.address);
      const adminBefore = await pool.supplyBalanceOf(admin.address);
      await pool
        .connect(alice)
        .liquidate(bob.address, ethers.MaxUint256, 0n, BigInt(await time.latest()) + 300n, NO_UPDATE);
      const aliceLoss = aliceBefore - (await pool.supplyBalanceOf(alice.address));
      const adminLoss = adminBefore - (await pool.supplyBalanceOf(admin.address));
      expect(aliceLoss).to.be.gt(2n * ONE_USDX);
      expect(aliceLoss - adminLoss * 2n).to.be.within(-2n, 2n);
      expect(await pool.totalReserves()).to.be.lte(1n);
      expect(await pool.borrowBalanceOf(bob.address)).to.equal(0n);
      await pool.connect(admin).supply(100n * ONE_USDX);
      await assertAccounting(f, [alice.address, admin.address, bob.address]);
    });

    it("does not lend or withdraw the faucet allocation", async () => {
      const f = await loadFixture(deployFixture);
      const { admin, alice, bob, pool, usdx } = f;
      await usdx.connect(admin).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdx.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(admin).fundFaucet(1_000n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      expect(await pool.availableLiquidity()).to.equal(0n);
      await expect(pool.connect(bob).borrow(ONE_USDX, NO_UPDATE)).to.be.revertedWith("insufficient liquidity");
      await pool.connect(alice).supply(ONE_USDX);
      await pool.connect(bob).borrow(ONE_USDX, NO_UPDATE);
      await expect(pool.connect(alice).withdrawSupply(ONE_USDX)).to.be.revertedWith("insufficient liquidity");
      await pool.connect(bob).claimFaucet();
      expect(await pool.faucetBudget()).to.equal(750n * ONE_USDX);
      await assertAccounting(f, [admin.address, alice.address, bob.address]);
    });

    it("recognizes direct token donations as reserves instead of unowned lending capital", async () => {
      const f = await loadFixture(deployFixture);
      const { admin, alice, bob, pool, usdx } = f;
      await usdx.connect(admin).transfer(await pool.getAddress(), 100n * ONE_USDX);
      expect(await pool.availableLiquidity()).to.equal(0n);
      await expect(pool.accrue())
        .to.emit(pool, "SurplusRecognized")
        .withArgs(100n * ONE_USDX);
      expect(await pool.totalReserves()).to.equal(100n * ONE_USDX);
      await pool.connect(bob).depositCollateral({ value: 100n * ONE_HBAR });
      await expect(pool.connect(bob).borrow(ONE_USDX, NO_UPDATE)).to.be.revertedWith("insufficient liquidity");
      await usdx.connect(alice).approve(await pool.getAddress(), ONE_USDX);
      await pool.connect(alice).supply(ONE_USDX);
      expect(await pool.availableLiquidity()).to.equal(ONE_USDX);
      await assertAccounting(f, [admin.address, alice.address, bob.address]);
    });

    it("allows debt-free collateral exits during an oracle outage but protects indebted positions", async () => {
      const { alice, bob, pool } = await loadFixture(activeFixture);
      await pool.connect(alice).depositCollateral({ value: ONE_HBAR });
      await time.increase(121);
      await expect(pool.connect(alice).withdrawCollateral(ONE_HBAR, NO_UPDATE, { value: 5n })).to.changeEtherBalance(
        pool,
        -ONE_HBAR,
      );
      expect(await pool.collateralOf(alice.address)).to.equal(0n);
      await expect(pool.connect(bob).withdrawCollateral(ONE_HBAR, NO_UPDATE)).to.be.revertedWith("stale price");
    });

    it("aligns liquidation health with the 80% threshold while keeping borrowing at 75%", async () => {
      const { bob, pool } = await loadFixture(activeFixture);
      const price = 190_000_000_000_000_000n; // 15 debt / 19 collateral = 78.95% LTV
      expect(await pool.healthFactorOf(bob.address, price)).to.be.gt(10n ** 18n);
      expect(await pool.isLiquidatable(bob.address, price)).to.equal(false);
      const lowerPrice = 180_000_000_000_000_000n;
      expect(await pool.healthFactorOf(bob.address, lowerPrice)).to.be.lt(10n ** 18n);
      expect(await pool.isLiquidatable(bob.address, lowerPrice)).to.equal(true);
    });
  });

  describe("oracle fee safety", () => {
    it("forwards only the Pyth fee, refunds empty updates, and records freshness", async () => {
      const { pool, pyth } = await loadFixture(deployFixture);
      await pyth.setUpdateFee(7n);
      await expect(pool.updatePrice(["0x1234"], { value: 6n })).to.be.revertedWith("insufficient Pyth fee");
      await expect(pool.updatePrice(["0x1234"], { value: 11n })).to.changeEtherBalances([pool, pyth], [0n, 7n]);
      expect(await pool.latestPricePublishTime()).to.equal(await pyth.publishTime());
      await expect(pool.updatePrice([], { value: 11n })).to.changeEtherBalance(pool, 0n);
      await time.increase(121);
      await expect(pool.updatePrice([])).to.be.revertedWith("stale price");
      await pool.updatePrice(["0x1234"], { value: 7n });
    });

    it("blocks reentrancy from an oracle fee refund", async () => {
      const { pool } = await loadFixture(deployFixture);
      const receiver = await ethers.deployContract("RefundReceiver", [await pool.getAddress()]);
      await receiver.update([], { value: 123n });
      expect(await receiver.refunded()).to.equal(123n);
      expect(await receiver.reentrySucceeded()).to.equal(false);
      expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
    });
  });
});
