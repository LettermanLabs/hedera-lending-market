// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./interfaces/IWHBAR.sol";
import "./interfaces/ISaucerSwapRouter.sol";
import "./interfaces/IHederaTokenService.sol";

/// @title LendingPool — a collateralized lending market on Hedera.
/// @notice Suppliers deposit an HTS stable asset (USDX) to earn interest; borrowers
///         lock HBAR collateral (wrapped into SaucerSwap WHBAR) to borrow USDX.
///         Borrowing power, withdrawals and liquidations are priced by the Pyth
///         pull oracle; underwater positions are settled by seizing collateral and
///         swapping it back to USDX on SaucerSwap V1.
///
///         Hedera services in play:
///           - HTS  : USDX (and WHBAR) are HTS tokens used through their ERC-20 facade,
///                    and the pool self-associates via the 0x167 precompile.
///           - HCSS : not used here directly — activity is mirrored to an HCS topic by
///                    the frontend/API layer (see packages/nextjs).
///           - EVM  : all accounting and settlement logic lives in this contract.
contract LendingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 internal constant WHBAR_DECIMALS = 8;
    uint8 internal constant USDX_DECIMALS = 6;

    IWHBAR public immutable whbar;
    IERC20 public immutable usdx;
    IPyth public immutable pyth;
    ISaucerSwapRouter public immutable saucerSwapRouter;
    bytes32 public immutable hbarUsdPriceId;
    address public immutable admin;

    // ── Risk parameters (18 decimals) ──────────────────────────────────────
    uint256 public constant COLLATERAL_FACTOR = 0.75e18; // max 75% LTV
    uint256 public constant LIQUIDATION_THRESHOLD = 0.80e18;
    uint256 public constant LIQUIDATION_BONUS = 0.05e18;
    uint256 public constant RESERVE_FACTOR = 0.10e18;

    // ── Interest model: borrow APY = intercept + slope * utilization ─────────
    uint256 public constant BORROW_RATE_INTERCEPT = 0.02e18;
    uint256 public constant BORROW_RATE_SLOPE = 0.38e18;
    uint256 public constant SECONDS_PER_YEAR = 31_536_000;

    // ── Indexes (1e18 = 1.0) ─────────────────────────────────────────────────
    uint256 public supplyIndex = 1e18;
    uint256 public borrowIndex = 1e18;
    uint256 public lastAccrual;
    uint256 public totalSupplyScaled;
    uint256 public totalBorrowScaled;
    uint256 public totalReserves;

    mapping(address => uint256) public supplyScaled; // USDX suppliers
    mapping(address => uint256) public borrowScaled; // USDX borrowers
    mapping(address => uint256) public collateralOf; // WHBAR collateral

    uint256 public latestPrice18; // last Pyth HBAR/USD price, 18 decimals

    // ── Testnet faucet ────────────────────────────────────────────────────────
    uint256 public constant FAUCET_AMOUNT = 250e6; // 250 USDX (6 decimals)
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    bool public faucetEnabled = true;
    uint256 public faucetBudget;
    mapping(address => uint256) public lastFaucetAt;

    event CollateralDeposited(address indexed account, uint256 amount);
    event CollateralWithdrawn(address indexed account, uint256 amount);
    event Supplied(address indexed account, uint256 amount);
    event SupplyWithdrawn(address indexed account, uint256 amount);
    event Borrowed(address indexed account, uint256 amount);
    event Repaid(address indexed account, uint256 amount);
    event Liquidated(
        address indexed borrower,
        address indexed liquidator,
        uint256 repaid,
        uint256 whbarSeized,
        uint256 usdxRecovered
    );
    event FaucetClaimed(address indexed account, uint256 amount);
    event PriceUpdated(uint256 price18, uint64 publishTime);

    error InsufficientCollateral();
    error HealthyPosition();
    error TransferFailed();

    constructor(address _whbar, address _usdx, address _pyth, bytes32 _hbarUsdPriceId, address _saucerSwapRouter) {
        whbar = IWHBAR(_whbar);
        usdx = IERC20(_usdx);
        pyth = IPyth(_pyth);
        hbarUsdPriceId = _hbarUsdPriceId;
        saucerSwapRouter = ISaucerSwapRouter(_saucerSwapRouter);
        admin = msg.sender;
        lastAccrual = block.timestamp;
    }

    /// @notice The pool receives native HBAR when unwrapping WHBAR on withdrawal.
    receive() external payable {}

    // ── Hedera Token Service ──────────────────────────────────────────────────

    /// @notice Associate the pool with WHBAR and USDX via the HTS precompile (0x167).
    ///         Anyone may call; duplicate association is harmless (code 194).
    function associateTokens() external {
        IHederaTokenService hts = IHederaTokenService(HTS_PRECOMPILE);
        int64 codeA = hts.associateToken(address(this), address(whbar));
        require(codeA == HTS_SUCCESS || codeA == HTS_ALREADY_ASSOCIATED, "WHBAR association failed");
        int64 codeB = hts.associateToken(address(this), address(usdx));
        require(codeB == HTS_SUCCESS || codeB == HTS_ALREADY_ASSOCIATED, "USDX association failed");
    }

    /// @notice Associate an arbitrary HTS token with the pool — used for SaucerSwap
    ///         LP tokens during AMM seeding, or future listed assets.
    function associateToken(address token) external {
        require(msg.sender == admin, "not admin");
        int64 code = IHederaTokenService(HTS_PRECOMPILE).associateToken(address(this), token);
        require(code == HTS_SUCCESS || code == HTS_ALREADY_ASSOCIATED, "association failed");
    }

    // ── Interest accrual ──────────────────────────────────────────────────────

    function accrue() public {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return;
        lastAccrual = block.timestamp;

        uint256 supplyU = totalSupply();
        uint256 borrowU = totalBorrow();
        if (borrowU == 0) return;

        uint256 util = supplyU == 0 ? 0 : Math.mulDiv(borrowU, 1e18, supplyU);
        uint256 borrowApy = BORROW_RATE_INTERCEPT + Math.mulDiv(util, BORROW_RATE_SLOPE, 1e18);
        uint256 interest = Math.mulDiv(borrowU, borrowApy * dt, 1e18 * SECONDS_PER_YEAR);

        uint256 reserveDelta = Math.mulDiv(interest, RESERVE_FACTOR, 1e18);
        totalReserves += reserveDelta;

        if (supplyU == 0) {
            // No suppliers: interest accrues entirely to reserves.
            uint256 borrowOnly = borrowU + interest;
            borrowIndex = Math.mulDiv(borrowIndex, borrowOnly, borrowU);
            totalBorrowScaled = Math.mulDiv(borrowOnly, 1e18, borrowIndex);
            return;
        }

        uint256 supplierDelta = interest - reserveDelta;
        uint256 newSupplyU = supplyU + supplierDelta;
        uint256 newBorrowU = borrowU + interest;

        supplyIndex = Math.mulDiv(supplyIndex, newSupplyU, supplyU);
        borrowIndex = Math.mulDiv(borrowIndex, newBorrowU, borrowU);
        totalSupplyScaled = Math.mulDiv(newSupplyU, 1e18, supplyIndex);
        totalBorrowScaled = Math.mulDiv(newBorrowU, 1e18, borrowIndex);
    }

    function totalSupply() public view returns (uint256) {
        return Math.mulDiv(totalSupplyScaled, supplyIndex, 1e18);
    }

    function totalBorrow() public view returns (uint256) {
        return Math.mulDiv(totalBorrowScaled, borrowIndex, 1e18);
    }

    function supplyBalanceOf(address account) public view returns (uint256) {
        return Math.mulDiv(supplyScaled[account], supplyIndex, 1e18);
    }

    function borrowBalanceOf(address account) public view returns (uint256) {
        return Math.mulDiv(borrowScaled[account], borrowIndex, 1e18);
    }

    // ── Pyth pull oracle ──────────────────────────────────────────────────────

    /// @notice Submit a signed Pyth price update (empty array to skip) and cache the
    ///         fresh HBAR/USD price. Excess msg.value is refunded.
    function updatePrice(bytes[] calldata priceUpdateData) public payable returns (uint256 price18) {
        if (priceUpdateData.length > 0) {
            uint256 fee = pyth.getUpdateFee(priceUpdateData);
            require(msg.value >= fee, "insufficient Pyth fee");
            pyth.updatePriceFeeds{value: fee}(priceUpdateData);
            uint256 refund = msg.value - fee;
            if (refund > 0) {
                (bool ok, ) = msg.sender.call{value: refund}("");
                require(ok, "fee refund failed");
            }
        }
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(hbarUsdPriceId, 120 seconds);
        require(p.price > 0, "invalid price");
        uint256 scale = 10 ** uint256(18 + int256(p.expo));
        price18 = uint256(uint64(p.price)) * scale;
        latestPrice18 = price18;
        emit PriceUpdated(price18, uint64(p.publishTime));
    }

    // ── Pricing helpers (18-decimal USD values) ───────────────────────────────

    function _whbarValue(uint256 amount, uint256 price18) internal pure returns (uint256) {
        return Math.mulDiv(amount, price18, 10 ** WHBAR_DECIMALS);
    }

    function _usdxValue(uint256 amount) internal pure returns (uint256) {
        // USDX is treated as a $1.00 stable asset (see README "Assumptions").
        return Math.mulDiv(amount, 1e18, 10 ** USDX_DECIMALS);
    }

    function _whbarFromUsd(uint256 usdValue18, uint256 price18) internal pure returns (uint256) {
        return Math.mulDiv(usdValue18, 10 ** WHBAR_DECIMALS, price18);
    }

    // ── Collateral (HBAR) ─────────────────────────────────────────────────────

    /// @notice Deposit native HBAR as collateral. It is wrapped into SaucerSwap WHBAR
    ///         and custodied by the pool.
    function depositCollateral() external payable nonReentrant {
        require(msg.value > 0, "no HBAR sent");
        whbar.deposit{value: msg.value}();
        collateralOf[msg.sender] += msg.value;
        emit CollateralDeposited(msg.sender, msg.value);
    }

    function withdrawCollateral(uint256 amount, bytes[] calldata priceUpdateData) external payable nonReentrant {
        require(collateralOf[msg.sender] >= amount, "insufficient collateral");
        uint256 price18 = updatePrice(priceUpdateData);
        collateralOf[msg.sender] -= amount;
        if (!_isHealthy(msg.sender, price18)) revert InsufficientCollateral();
        whbar.withdraw(amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ── Supply / borrow ───────────────────────────────────────────────────────

    function supply(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        accrue();
        usdx.safeTransferFrom(msg.sender, address(this), amount);
        uint256 scaled = Math.mulDiv(amount, 1e18, supplyIndex);
        supplyScaled[msg.sender] += scaled;
        totalSupplyScaled += scaled;
        emit Supplied(msg.sender, amount);
    }

    function withdrawSupply(uint256 amount) external nonReentrant {
        accrue();
        require(supplyBalanceOf(msg.sender) >= amount, "insufficient supply");
        uint256 scaled = Math.mulDiv(amount, 1e18, supplyIndex);
        supplyScaled[msg.sender] -= scaled;
        totalSupplyScaled -= scaled;
        usdx.safeTransfer(msg.sender, amount);
        emit SupplyWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount, bytes[] calldata priceUpdateData) external payable nonReentrant {
        require(amount > 0, "zero amount");
        accrue();
        uint256 price18 = updatePrice(priceUpdateData);
        uint256 newBorrow = borrowBalanceOf(msg.sender) + amount;
        uint256 maxBorrow = Math.mulDiv(_whbarValue(collateralOf[msg.sender], price18), COLLATERAL_FACTOR, 1e18);
        if (_usdxValue(newBorrow) > maxBorrow) revert InsufficientCollateral();
        uint256 scaled = Math.mulDiv(amount, 1e18, borrowIndex);
        borrowScaled[msg.sender] += scaled;
        totalBorrowScaled += scaled;
        usdx.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        accrue();
        uint256 pay = Math.min(amount, borrowBalanceOf(msg.sender));
        require(pay > 0, "nothing owed");
        usdx.safeTransferFrom(msg.sender, address(this), pay);
        uint256 scaled = Math.mulDiv(pay, 1e18, borrowIndex);
        borrowScaled[msg.sender] -= scaled;
        totalBorrowScaled -= scaled;
        emit Repaid(msg.sender, pay);
    }

    // ── Liquidation ───────────────────────────────────────────────────────────

    /// @notice Repay a borrower's debt, seize a discounted slice of the borrower's
    ///         WHBAR collateral, swap it back to USDX on SaucerSwap V1 and pay the
    ///         recovered USDX to the liquidator. The liquidator's profit is the gap
    ///         between the debt repaid and the swap proceeds; the protocol's loss is
    ///         bounded by the liquidation bonus. Collateral exhaustion with residual
    ///         debt is absorbed by the pool (socialized across suppliers).
    function liquidate(
        address borrower,
        uint256 repayAmount,
        uint256 minUsdxOut,
        uint256 deadline,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant {
        require(borrower != msg.sender, "self liquidation");
        accrue();
        uint256 price18 = updatePrice(priceUpdateData);
        if (!isLiquidatable(borrower, price18)) revert HealthyPosition();

        uint256 pay = Math.min(repayAmount, borrowBalanceOf(borrower));
        usdx.safeTransferFrom(msg.sender, address(this), pay);
        uint256 debtScaled = Math.mulDiv(pay, 1e18, borrowIndex);
        borrowScaled[borrower] -= debtScaled;
        totalBorrowScaled -= debtScaled;

        uint256 seizeUsd18 = Math.mulDiv(_usdxValue(pay), 1e18 + LIQUIDATION_BONUS, 1e18);
        uint256 seizeWhbar = Math.min(_whbarFromUsd(seizeUsd18, price18), collateralOf[borrower]);
        collateralOf[borrower] -= seizeWhbar;

        IERC20(address(whbar)).forceApprove(address(saucerSwapRouter), seizeWhbar);
        address[] memory path = new address[](2);
        path[0] = address(whbar);
        path[1] = address(usdx);
        uint256[] memory amounts = saucerSwapRouter.swapExactTokensForTokens(
            seizeWhbar,
            minUsdxOut,
            path,
            address(this),
            deadline
        );
        uint256 recovered = amounts[amounts.length - 1];
        usdx.safeTransfer(msg.sender, recovered);

        emit Liquidated(borrower, msg.sender, pay, seizeWhbar, recovered);
    }

    // ── Health ────────────────────────────────────────────────────────────────

    function _isHealthy(address account, uint256 price18) internal view returns (bool) {
        uint256 borrowValue = _usdxValue(borrowBalanceOf(account));
        if (borrowValue == 0) return true;
        uint256 maxBorrow = Math.mulDiv(_whbarValue(collateralOf[account], price18), COLLATERAL_FACTOR, 1e18);
        return borrowValue <= maxBorrow;
    }

    function isLiquidatable(address account, uint256 price18) public view returns (bool) {
        uint256 borrowValue = _usdxValue(borrowBalanceOf(account));
        if (borrowValue == 0) return false;
        uint256 threshold = Math.mulDiv(_whbarValue(collateralOf[account], price18), LIQUIDATION_THRESHOLD, 1e18);
        return borrowValue > threshold;
    }

    /// @notice Borrowing-power ratio; > 1e18 is healthy, 0 debt is max uint.
    function healthFactorOf(address account, uint256 price18) public view returns (uint256) {
        uint256 borrowValue = _usdxValue(borrowBalanceOf(account));
        if (borrowValue == 0) return type(uint256).max;
        return Math.mulDiv(_whbarValue(collateralOf[account], price18), COLLATERAL_FACTOR, borrowValue);
    }

    // ── Testnet faucet ────────────────────────────────────────────────────────

    function claimFaucet() external nonReentrant {
        require(faucetEnabled, "faucet disabled");
        require(block.timestamp >= lastFaucetAt[msg.sender] + FAUCET_COOLDOWN, "faucet cooldown");
        require(faucetBudget >= FAUCET_AMOUNT, "faucet drained");
        faucetBudget -= FAUCET_AMOUNT;
        lastFaucetAt[msg.sender] = block.timestamp;
        usdx.safeTransfer(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    function fundFaucet(uint256 amount) external nonReentrant {
        require(msg.sender == admin, "not admin");
        usdx.safeTransferFrom(msg.sender, address(this), amount);
        faucetBudget += amount;
    }

    function setFaucetEnabled(bool enabled) external {
        require(msg.sender == admin, "not admin");
        faucetEnabled = enabled;
    }
}
