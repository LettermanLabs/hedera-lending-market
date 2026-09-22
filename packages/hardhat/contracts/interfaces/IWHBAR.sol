// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice SaucerSwap WHBAR is referenced by address only (V1 swap paths start
///         at the WHBAR token address; the router handles wrapping itself).
interface IWHBAR is IERC20 {}
