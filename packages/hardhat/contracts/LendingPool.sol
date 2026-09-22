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
///         lock native HBAR collateral to borrow USDX.
///         Borrowing power, withdrawals and liquidations are priced by the Pyth
///         pull oracle; underwater positions are settled by seizing collateral and
///         swapping it back to USDX on SaucerSwap V1.
///
///         Hedera services in play:
///           - HTS: USDX (and WHBAR in the swap path) are HTS tokens used through their
///             ERC-20 facade, and the pool self-associates via the 0x167 precompile.
///           - HCS: activity is mirrored to a topic by the frontend/API layer
///             (see packages/nextjs); this contract emits the events it mirrors.
///           - EVM: all accounting and settlement logic lives in this contract.
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
    uint256 private reserveRemainder;

    // A complete loss retires old shares without iterating over suppliers. The
    // public getter reports only the current epoch, so a recapitalization cannot
    // accidentally restore claims that were already written off.
    uint256 public supplyEpoch;
    mapping(address => uint256) private supplierEpoch;
    mapping(address => uint256) private supplierShares;
    mapping(address => uint256) public borrowScaled; // USDX borrowers
    mapping(address => uint256) public collateralOf; // Native HBAR, in tinybar (8 decimals)

    uint256 public latestPrice18; // last Pyth HBAR/USD price, 18 decimals
    uint64 public latestPricePublishTime;

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
    event BadDebtResolved(address indexed borrower, uint256 debt, uint256 reservesUsed, uint256 supplierLoss);
    event SurplusRecognized(uint256 amount);

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

    /// @notice Accept native HBAR, including oracle fee refunds.
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

    function accrue() external nonReentrant {
        _accrue();
    }

    function _accrue() internal {
        uint256 reserveDelta;
        (supplyIndex, borrowIndex, reserveDelta, reserveRemainder) = _previewAccrual();
        totalReserves += reserveDelta;
        lastAccrual = block.timestamp;
        // Direct token donations have no supplier shares. Recognize them as
        // protocol reserves instead of lending capital with no loss-bearing owner.
        uint256 assets = usdx.balanceOf(address(this)) + _storedBorrow();
        uint256 liabilities = _storedSupply() + totalReserves + faucetBudget;
        if (assets > liabilities) {
            uint256 surplus = assets - liabilities;
            totalReserves += surplus;
            emit SurplusRecognized(surplus);
        }
    }

    function _storedSupply() internal view returns (uint256) {
        return Math.mulDiv(totalSupplyScaled, supplyIndex, 1e18);
    }

    function _storedBorrow() internal view returns (uint256) {
        return Math.mulDiv(totalBorrowScaled, borrowIndex, 1e18, Math.Rounding.Ceil);
    }

    /// @dev Shares never change during accrual. Accruing the index directly also
    ///      preserves sub-token interest when operations occur only seconds apart.
    function _previewAccrual()
        internal
        view
        returns (uint256 nextSupply, uint256 nextBorrow, uint256 reserves, uint256 remainder)
    {
        nextSupply = supplyIndex;
        nextBorrow = borrowIndex;
        remainder = reserveRemainder;
        uint256 dt = block.timestamp - lastAccrual;
        uint256 borrowU = _storedBorrow();
        if (dt == 0 || borrowU == 0) return (nextSupply, nextBorrow, 0, remainder);

        uint256 supplyU = _storedSupply();
        uint256 util = supplyU == 0 ? 1e18 : Math.min(Math.mulDiv(borrowU, 1e18, supplyU), 1e18);
        uint256 borrowApy = BORROW_RATE_INTERCEPT + Math.mulDiv(util, BORROW_RATE_SLOPE, 1e18);
        nextBorrow += Math.mulDiv(borrowIndex, borrowApy * dt, 1e18 * SECONDS_PER_YEAR);
        uint256 interest = Math.mulDiv(totalBorrowScaled, nextBorrow, 1e18, Math.Rounding.Ceil) - borrowU;
        if (totalSupplyScaled == 0) return (nextSupply, nextBorrow, interest, remainder);

        // Carry the fractional reserve allocation across calls. Otherwise a caller
        // could change the reserve split by repeatedly accruing tiny amounts.
        uint256 reserveCut = Math.mulDiv(interest, RESERVE_FACTOR, 1e18);
        remainder += mulmod(interest, RESERVE_FACTOR, 1e18);
        reserveCut += remainder / 1e18;
        remainder %= 1e18;
        nextSupply += Math.mulDiv(interest - reserveCut, 1e18, totalSupplyScaled);
        uint256 supplierGain = Math.mulDiv(totalSupplyScaled, nextSupply, 1e18) - supplyU;
        reserves = interest - supplierGain;
    }

    function totalSupply() public view returns (uint256) {
        (uint256 index, , , ) = _previewAccrual();
        return Math.mulDiv(totalSupplyScaled, index, 1e18);
    }

    function totalBorrow() public view returns (uint256) {
        (, uint256 index, , ) = _previewAccrual();
        return Math.mulDiv(totalBorrowScaled, index, 1e18, Math.Rounding.Ceil);
    }

    function supplyScaled(address account) public view returns (uint256) {
        return supplierEpoch[account] == supplyEpoch ? supplierShares[account] : 0;
    }

    function supplyBalanceOf(address account) public view returns (uint256) {
        (uint256 index, , , ) = _previewAccrual();
        return Math.mulDiv(supplyScaled(account), index, 1e18);
    }

    function borrowBalanceOf(address account) public view returns (uint256) {
        (, uint256 index, , ) = _previewAccrual();
        return Math.mulDiv(borrowScaled[account], index, 1e18, Math.Rounding.Ceil);
    }

    /// @notice Cash available to suppliers and borrowers, excluding earmarked funds.
    function availableLiquidity() public view returns (uint256) {
        (uint256 nextSupply, uint256 nextBorrow, uint256 pendingReserves, ) = _previewAccrual();
        uint256 earmarked = faucetBudget + totalReserves + pendingReserves;
        uint256 cash = usdx.balanceOf(address(this));
        uint256 assets = cash + Math.mulDiv(totalBorrowScaled, nextBorrow, 1e18, Math.Rounding.Ceil);
        uint256 liabilities = Math.mulDiv(totalSupplyScaled, nextSupply, 1e18) + earmarked;
        if (assets > liabilities) earmarked += assets - liabilities;
        return cash > earmarked ? cash - earmarked : 0;
    }

    // ── Pyth pull oracle ──────────────────────────────────────────────────────

    /// @notice Submit a signed Pyth price update (empty array to skip) and cache the
    ///         fresh HBAR/USD price. Excess msg.value is refunded.
    function updatePrice(bytes[] calldata priceUpdateData) external payable nonReentrant returns (uint256 price18) {
        return _updatePrice(priceUpdateData);
    }

    function _updatePrice(bytes[] calldata priceUpdateData) internal returns (uint256 price18) {
        uint256 fee;
        if (priceUpdateData.length > 0) {
            fee = pyth.getUpdateFee(priceUpdateData);
            require(msg.value >= fee, "insufficient Pyth fee");
            pyth.updatePriceFeeds{value: fee}(priceUpdateData);
        }
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(hbarUsdPriceId, 120 seconds);
        require(p.price > 0, "invalid price");
        require(p.expo >= -18 && p.expo <= 18, "unsupported exponent");
        uint256 scale = 10 ** uint256(18 + int256(p.expo));
        price18 = uint256(uint64(p.price)) * scale;
        latestPrice18 = price18;
        latestPricePublishTime = uint64(p.publishTime);
        emit PriceUpdated(price18, latestPricePublishTime);
        _refund(msg.value - fee);
    }

    function _refund(uint256 refund) internal {
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "fee refund failed");
        }
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

    /// @notice Deposit native HBAR as collateral, custodied directly by the pool.
    ///         HBAR stays native: liquidations swap it through SaucerSwap's
    ///         payable ETH functions (the router wraps it into WHBAR itself).
    function depositCollateral() external payable nonReentrant {
        require(msg.value > 0, "no HBAR sent");
        collateralOf[msg.sender] += msg.value;
        emit CollateralDeposited(msg.sender, msg.value);
    }

    function withdrawCollateral(uint256 amount, bytes[] calldata priceUpdateData) external payable nonReentrant {
        require(amount > 0, "zero amount");
        require(collateralOf[msg.sender] >= amount, "insufficient collateral");
        _accrue();
        collateralOf[msg.sender] -= amount;
        if (borrowScaled[msg.sender] > 0) {
            uint256 price18 = _updatePrice(priceUpdateData);
            if (!_isHealthy(msg.sender, price18)) revert InsufficientCollateral();
        } else {
            // A debt-free exit has no price risk and must remain available even
            // when the external oracle is stale or unavailable.
            _refund(msg.value);
        }
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ── Supply / borrow ───────────────────────────────────────────────────────

    function supply(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        _accrue();
        uint256 scaled = Math.mulDiv(amount, 1e18, supplyIndex);
        require(scaled > 0, "amount too small");
        uint256 beforeSupply = _storedSupply();
        if (supplierEpoch[msg.sender] != supplyEpoch) {
            supplierEpoch[msg.sender] = supplyEpoch;
            supplierShares[msg.sender] = 0;
        }
        supplierShares[msg.sender] += scaled;
        totalSupplyScaled += scaled;
        totalReserves += amount - (_storedSupply() - beforeSupply);
        usdx.safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(msg.sender, amount);
    }

    function withdrawSupply(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        _accrue();
        uint256 balance = supplyBalanceOf(msg.sender);
        require(balance >= amount, "insufficient supply");
        require(availableLiquidity() >= amount, "insufficient liquidity");
        uint256 beforeSupply = _storedSupply();
        uint256 scaled = amount == balance
            ? supplyScaled(msg.sender)
            : Math.mulDiv(amount, 1e18, supplyIndex, Math.Rounding.Ceil);
        supplierShares[msg.sender] -= scaled;
        totalSupplyScaled -= scaled;
        totalReserves += beforeSupply - _storedSupply() - amount;
        usdx.safeTransfer(msg.sender, amount);
        emit SupplyWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount, bytes[] calldata priceUpdateData) external payable nonReentrant {
        require(amount > 0, "zero amount");
        _accrue();
        uint256 price18 = _updatePrice(priceUpdateData);
        require(availableLiquidity() >= amount, "insufficient liquidity");
        uint256 beforeBorrow = _storedBorrow();
        uint256 scaled = Math.mulDiv(amount, 1e18, borrowIndex, Math.Rounding.Ceil);
        borrowScaled[msg.sender] += scaled;
        totalBorrowScaled += scaled;
        if (!_isHealthy(msg.sender, price18)) revert InsufficientCollateral();
        totalReserves += _storedBorrow() - beforeBorrow - amount;
        usdx.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        _accrue();
        require(borrowScaled[msg.sender] > 0, "nothing owed");
        uint256 pay = _repaymentAmount(msg.sender, amount, borrowIndex);
        require(pay > 0, "amount too small");
        _burnDebt(msg.sender, pay);
        usdx.safeTransferFrom(msg.sender, address(this), pay);
        emit Repaid(msg.sender, pay);
    }

    function _repaymentAmount(address account, uint256 amount, uint256 index) internal view returns (uint256) {
        uint256 debt = Math.mulDiv(borrowScaled[account], index, 1e18, Math.Rounding.Ceil);
        if (amount >= debt) return debt;
        uint256 shares = Math.mulDiv(amount, 1e18, index);
        return Math.mulDiv(shares, index, 1e18, Math.Rounding.Ceil);
    }

    /// @dev Full repayment burns every share. Partial repayment never cancels more
    ///      aggregate debt than the cash received; integer dust belongs to reserves.
    function _burnDebt(address account, uint256 pay) internal {
        uint256 beforeBorrow = _storedBorrow();
        uint256 debt = Math.mulDiv(borrowScaled[account], borrowIndex, 1e18, Math.Rounding.Ceil);
        uint256 scaled = pay >= debt ? borrowScaled[account] : Math.mulDiv(pay, 1e18, borrowIndex);
        borrowScaled[account] -= scaled;
        totalBorrowScaled -= scaled;
        totalReserves += pay - (beforeBorrow - _storedBorrow());
    }

    // ── Liquidation ───────────────────────────────────────────────────────────

    /// @notice Repay a borrower's debt, seize a discounted slice of the borrower's
    ///         native HBAR collateral, swap it to USDX on SaucerSwap V1 and pay the
    ///         recovered USDX to the liquidator. The liquidator's profit is the gap
    ///         between the debt repaid and the swap proceeds. Exhausted collateral
    ///         causes residual debt to be written off against reserves first, then
    ///         proportionally against suppliers. No interest accrues on written-off debt.
    function liquidate(
        address borrower,
        uint256 repayAmount,
        uint256 minUsdxOut,
        uint256 deadline,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant {
        require(borrower != msg.sender, "self liquidation");
        require(repayAmount > 0, "zero amount");
        _accrue();
        uint256 price18 = _updatePrice(priceUpdateData);
        if (!isLiquidatable(borrower, price18)) revert HealthyPosition();

        (uint256 pay, uint256 seizeWhbar) = previewLiquidation(borrower, repayAmount, price18);
        if (collateralOf[borrower] > 0) require(pay > 0 && seizeWhbar > 0, "amount too small");
        if (pay > 0) {
            _burnDebt(borrower, pay);
            usdx.safeTransferFrom(msg.sender, address(this), pay);
        }
        collateralOf[borrower] -= seizeWhbar;
        if (collateralOf[borrower] == 0) _resolveBadDebt(borrower);

        // Swap the seized native HBAR through SaucerSwap V1's payable ETH entry
        // point (path starts at the WHBAR token address; the router wraps HBAR
        // itself). Recovered USDX is paid to the liquidator.
        uint256 recovered;
        if (seizeWhbar > 0) {
            address[] memory path = new address[](2);
            path[0] = address(whbar);
            path[1] = address(usdx);
            uint256 beforeSwap = usdx.balanceOf(address(this));
            saucerSwapRouter.swapExactETHForTokens{value: seizeWhbar}(minUsdxOut, path, address(this), deadline);
            recovered = usdx.balanceOf(address(this)) - beforeSwap;
            require(recovered >= minUsdxOut, "insufficient swap output");
            usdx.safeTransfer(msg.sender, recovered);
        } else {
            require(minUsdxOut == 0, "insufficient swap output");
        }

        emit Liquidated(borrower, msg.sender, pay, seizeWhbar, recovered);
    }

    /// @notice Quote the repay amount (USDX, 6 decimals) and seizure (HBAR tinybar,
    ///         8 decimals) using pending interest and the supplied 18-decimal price.
    ///         This quote does not authenticate the price or guarantee eligibility.
    function previewLiquidation(
        address borrower,
        uint256 repayAmount,
        uint256 price18
    ) public view returns (uint256 pay, uint256 seizeHbar) {
        require(price18 > 0, "invalid price");
        uint256 collateral = collateralOf[borrower];
        if (collateral == 0 || repayAmount == 0) return (0, 0);
        (, uint256 index, , ) = _previewAccrual();
        uint256 debt = Math.mulDiv(borrowScaled[borrower], index, 1e18, Math.Rounding.Ceil);
        uint256 limit = Math.min(repayAmount, debt);
        uint256 collateralPay = Math.max(
            1,
            Math.mulDiv(
                _whbarValue(collateral, price18),
                10 ** USDX_DECIMALS,
                1e18 + LIQUIDATION_BONUS,
                Math.Rounding.Ceil
            )
        );
        if (limit >= collateralPay) return (collateralPay, collateral);
        pay = _repaymentAmount(borrower, limit, index);
        uint256 seizeUsd18 = Math.mulDiv(_usdxValue(pay), 1e18 + LIQUIDATION_BONUS, 1e18);
        seizeHbar = Math.min(_whbarFromUsd(seizeUsd18, price18), collateral);
    }

    function _resolveBadDebt(address borrower) internal {
        uint256 shares = borrowScaled[borrower];
        if (shares == 0) return;
        uint256 beforeBorrow = _storedBorrow();
        borrowScaled[borrower] = 0;
        totalBorrowScaled -= shares;
        uint256 loss = beforeBorrow - _storedBorrow();
        uint256 reservesUsed = Math.min(loss, totalReserves);
        totalReserves -= reservesUsed;
        uint256 supplierLoss = loss - reservesUsed;
        if (supplierLoss > 0) {
            uint256 beforeSupply = _storedSupply();
            require(supplierLoss <= beforeSupply, "uncovered loss");
            uint256 remaining = beforeSupply - supplierLoss;
            supplyIndex = Math.mulDiv(remaining, 1e18, totalSupplyScaled);
            if (supplyIndex == 0) {
                // Any sub-index rounding remainder becomes reserve dust. Old
                // shares cannot participate in a future supplier's deposit.
                totalSupplyScaled = 0;
                supplyEpoch++;
                supplyIndex = 1e18;
            }
            totalReserves += remaining - _storedSupply();
        }
        emit BadDebtResolved(borrower, loss, reservesUsed, supplierLoss);
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

    /// @notice Liquidation health factor: below 1e18 is liquidatable; zero debt is max uint.
    function healthFactorOf(address account, uint256 price18) public view returns (uint256) {
        uint256 borrowValue = _usdxValue(borrowBalanceOf(account));
        if (borrowValue == 0) return type(uint256).max;
        return Math.mulDiv(_whbarValue(collateralOf[account], price18), LIQUIDATION_THRESHOLD, borrowValue);
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
        require(amount > 0, "zero amount");
        usdx.safeTransferFrom(msg.sender, address(this), amount);
        faucetBudget += amount;
    }

    function setFaucetEnabled(bool enabled) external {
        require(msg.sender == admin, "not admin");
        faucetEnabled = enabled;
    }
}
