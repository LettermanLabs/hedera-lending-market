// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @notice Minimal mock of the Pyth pull oracle with the exact selector surface the
///         pool uses, including configurable fees and stale-price rejection.
contract MockPyth {
    int64 public price;
    int32 public expo;
    uint64 public publishTime;
    uint256 public updateFee;

    constructor(int64 _price, int32 _expo) {
        price = _price;
        expo = _expo;
        publishTime = uint64(block.timestamp);
    }

    function setPrice(int64 _price) external {
        price = _price;
        publishTime = uint64(block.timestamp);
    }

    function setUpdateFee(uint256 fee) external {
        updateFee = fee;
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return updateFee;
    }

    function updatePriceFeeds(bytes[] calldata) external payable {
        require(msg.value == updateFee, "incorrect fee");
        publishTime = uint64(block.timestamp);
    }

    function getPriceNoOlderThan(bytes32, uint256 maxAge) external view returns (PythStructs.Price memory) {
        require(block.timestamp <= uint256(publishTime) + maxAge, "stale price");
        return PythStructs.Price({price: price, conf: 0, expo: expo, publishTime: publishTime});
    }

    function getPrice(bytes32) external view returns (PythStructs.Price memory) {
        return PythStructs.Price({price: price, conf: 0, expo: expo, publishTime: publishTime});
    }
}
