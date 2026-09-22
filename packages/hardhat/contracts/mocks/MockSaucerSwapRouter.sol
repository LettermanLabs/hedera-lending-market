// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fixed-rate mock of the SaucerSwap V1 router for local Hardhat tests.
///         `rate` is the USDX (6dp) amount per 1 WHBAR (8dp), scaled by 1e8.
contract MockSaucerSwapRouter {
    IERC20 public immutable tokenIn;
    IERC20 public immutable tokenOut;
    uint256 public rate;

    constructor(address _tokenIn, address _tokenOut, uint256 _rate) {
        tokenIn = IERC20(_tokenIn);
        tokenOut = IERC20(_tokenOut);
        rate = _rate;
    }

    function setRate(uint256 _rate) external {
        rate = _rate;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2, "bad path");
        uint256 out = (amountIn * rate) / 1e8;
        require(out >= amountOutMin, "slippage");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).transfer(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * rate) / 1e8;
    }

    /// @notice Withdraw tokens swept into the mock so tests can recycle them.
    function sweep(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }
}
