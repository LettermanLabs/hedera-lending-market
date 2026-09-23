// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LendingPool} from "../LendingPool.sol";

/// @notice Attempts reentrancy when the pool returns an excess oracle fee.
contract RefundReceiver {
    LendingPool public immutable pool;
    bool public reentrySucceeded;
    uint256 public refunded;

    constructor(LendingPool pool_) {
        pool = pool_;
    }

    function update(bytes[] calldata data) external payable {
        pool.updatePrice{value: msg.value}(data);
    }

    receive() external payable {
        refunded += msg.value;
        (reentrySucceeded, ) = address(pool).call(abi.encodeCall(pool.accrue, ()));
    }
}
