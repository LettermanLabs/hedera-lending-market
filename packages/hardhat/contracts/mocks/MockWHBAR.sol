// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice WETH9-style mock of SaucerSwap WHBAR for local Hardhat tests.
contract MockWHBAR is ERC20 {
    constructor() ERC20("Mock WHBAR", "WHBAR") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}
