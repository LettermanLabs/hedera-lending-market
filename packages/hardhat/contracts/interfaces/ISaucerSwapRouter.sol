// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal SaucerSwap V1 (Uniswap V2 style) router surface used by the pool.
///         Canonical deployments are listed in the README; on testnet the router is
///         account 0.0.19264 and on mainnet 0.0.3045981.
interface ISaucerSwapRouter {
    function factory() external view returns (address);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}
