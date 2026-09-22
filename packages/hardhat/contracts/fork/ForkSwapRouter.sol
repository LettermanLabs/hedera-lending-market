// SPDX-License-Identifier: GPL-3.0
// FORK-TEST ROUTER mirroring SaucerSwapV1RouterV3.swapExactETHForTokens
// (https://github.com/saucerswaplabs/saucerswap-periphery/blob/master/contracts/UniswapV2Router02.sol)
//
// The constant-product quote math (getAmountOut, 997/1000 fee) is verbatim from
// SaucerSwap's UniswapV2Library. The swap flow mirrors the real router:
// HBAR in -> WHBAR wrapper deposit to the pair -> pair.swap -> USDC out.
// Wired to the real mainnet WHBAR/USDC pair reserves seeded on the fork.
pragma solidity =0.6.12;

import "./libraries/SafeMath.sol";
import "./ForkPair.sol";
import "./ForkWHBARWrapper.sol";

contract ForkSwapRouter {
    using SafeMath for uint256;

    ForkPair public pair;
    address public whbarToken;
    ForkWHBARWrapper public wrapper;

    constructor(address _pair, address _whbarToken, address payable _wrapper) public {
        pair = ForkPair(_pair);
        whbarToken = _whbarToken;
        wrapper = ForkWHBARWrapper(_wrapper);
    }

    /// Verbatim from SaucerSwap's UniswapV2Library.getAmountOut (0.30% fee).
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "UniswapV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn.mul(997);
        uint256 numerator = amountInWithFee.mul(reserveOut);
        uint256 denominator = reserveIn.mul(1000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }

    /// Quote WHBAR -> USDC against the pair's real reserves.
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "UniswapV2Router: INVALID_PATH");
        require(path[0] == whbarToken, "UniswapV2Router: INVALID_PATH");
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        // token0 = USDC, token1 = WHBAR (sorted by address on the real pair)
        uint256 reserveIn = pair.token1() == whbarToken ? uint256(r1) : uint256(r0);
        uint256 reserveOut = pair.token1() == whbarToken ? uint256(r0) : uint256(r1);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = getAmountOut(amountIn, reserveIn, reserveOut);
    }

    /// Mirrors SaucerSwapV1RouterV3.swapExactETHForTokens.
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {
        require(path[0] == whbarToken, "UniswapV2Router: INVALID_PATH");
        require(block.timestamp <= deadline, "UniswapV2Router: EXPIRED");
        amounts = this.getAmountsOut(msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        // wrap HBAR into WHBAR at the pair — mirrors IWHBAR(WHBAR).deposit{value}(msg.sender, pair)
        wrapper.deposit{value: amounts[0]}(msg.sender, address(pair));
        // USDC is token0 on the real pair → amount0Out
        pair.swap(amounts[1], 0, to, new bytes(0));
    }
}
