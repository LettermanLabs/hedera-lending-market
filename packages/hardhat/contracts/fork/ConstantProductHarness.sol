// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Test-only conversion float. A local fork cannot mint HTS WHBAR, so it
///         transfers pre-funded real-token balances for simulated native HBAR.
///         This is not the deployed WHBAR wrapper and must not be deployed live.
contract NativeTokenFloat {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    constructor(IERC20 token_) {
        token = token_;
    }

    function deliver(address recipient) external payable {
        require(msg.value > 0, "empty native conversion");
        token.safeTransfer(recipient, msg.value);
    }
}

/// @notice Independently implemented local test harness for a single directional
///         constant-product swap with a 30-basis-point fee. It implements only the
///         quote/payable swap interface needed by LendingPool. It is not SaucerSwap
///         contract code or an emulation of its LP, factory, HTS, or fee machinery.
contract ConstantProductHarness is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable inputToken;
    IERC20 public immutable outputToken;
    NativeTokenFloat public immutable nativeFloat;
    address private immutable initializer;
    uint256 private inputInventory;
    uint256 private outputInventory;
    bool private initialized;

    constructor(IERC20 input_, IERC20 output_, NativeTokenFloat nativeFloat_) {
        inputToken = input_;
        outputToken = output_;
        nativeFloat = nativeFloat_;
        initializer = msg.sender;
    }

    /// @notice Record the test's initial, directly transferred token inventory.
    function seed() external {
        require(msg.sender == initializer && !initialized, "already seeded or not initializer");
        inputInventory = inputToken.balanceOf(address(this));
        outputInventory = outputToken.balanceOf(address(this));
        require(inputInventory > 0 && outputInventory > 0, "missing test inventory");
        initialized = true;
    }

    /// @notice Return test inventories in stable-token, WHBAR order.
    function getReserves() external view returns (uint256 stableUnits, uint256 hbarUnits) {
        return (outputInventory, inputInventory);
    }

    function getAmountsOut(uint256 inputUnits, address[] calldata path) public view returns (uint256[] memory quote) {
        require(initialized, "test inventory not seeded");
        require(
            path.length == 2 && path[0] == address(inputToken) && path[1] == address(outputToken),
            "unsupported test path"
        );
        require(inputUnits > 0, "empty swap");
        // Solve the constant-product equation after charging a 30/10,000 input
        // fee. Integer division deliberately rounds the recipient's output down.
        uint256 netInputNumerator = inputUnits * 9_970;
        uint256 outputUnits = Math.mulDiv(
            outputInventory,
            netInputNumerator,
            inputInventory * 10_000 + netInputNumerator
        );
        quote = new uint256[](2);
        quote[0] = inputUnits;
        quote[1] = outputUnits;
    }

    function swapExactETHForTokens(
        uint256 minimumOutput,
        address[] calldata path,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired test swap");
        amounts = getAmountsOut(msg.value, path);
        require(amounts[1] > 0 && amounts[1] >= minimumOutput, "test output below minimum");
        uint256 inputBefore = inputToken.balanceOf(address(this));
        nativeFloat.deliver{value: msg.value}(address(this));
        require(inputToken.balanceOf(address(this)) - inputBefore == msg.value, "conversion float shortfall");
        inputInventory += msg.value;
        outputInventory -= amounts[1];
        outputToken.safeTransfer(recipient, amounts[1]);
        require(inputToken.balanceOf(address(this)) == inputInventory, "input inventory mismatch");
        require(outputToken.balanceOf(address(this)) == outputInventory, "output inventory mismatch");
    }
}
