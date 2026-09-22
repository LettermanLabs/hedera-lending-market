// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The Hedera Token Service system precompile (0x167), used by the pool to
///         associate HTS tokens with its own account. Response codes follow
///         HederaResponseCodes: 22 = SUCCESS, 194 = TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT.
interface IHederaTokenService {
    function associateToken(address account, address token) external returns (int64 responseCode);
}

address constant HTS_PRECOMPILE = 0x0000000000000000000000000000000000000167;
int64 constant HTS_SUCCESS = 22;
int64 constant HTS_ALREADY_ASSOCIATED = 194;
