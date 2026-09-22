// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice SaucerSwap Wrapped HBAR (an HTS token with an ERC-20 facade).
interface IWHBAR is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
