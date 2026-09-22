// SPDX-License-Identifier: GPL-3.0
// FORK-TEST STAND-IN for SaucerSwap's WHBAR wrapper
// (https://github.com/saucerswaplabs/saucerswaplabs-core/blob/master/contracts/WHBAR.sol)
//
// The real wrapper mints/burns the WHBAR HTS token via the 0x167 precompile, which the
// fork emulation does not support. This stand-in is backed by a float of the REAL
// mainnet WHBAR token (seeded from the real WHBAR/USDC pair's reserves in the test),
// preserving the exact IWHBAR surface the SaucerSwap router calls:
//   deposit()/deposit(src, dst) payable — HBAR in, WHBAR out
//   withdraw(src, dst, wad)            — WHBAR in, HBAR out
pragma solidity =0.6.12;

import "./interfaces/IERC20.sol";

contract ForkWHBARWrapper {
    address public token; // the real WHBAR HTS token (ERC-20 facade on the fork)

    event Deposit(address indexed src, address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, address indexed dst, uint256 wad);

    constructor(address _token) public {
        token = _token;
    }

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        require(msg.value > 0, "Sent zero hbar to this contract");
        require(IERC20(token).transfer(msg.sender, msg.value), "WHBAR float transfer failed");
        emit Deposit(msg.sender, msg.sender, msg.value);
    }

    function deposit(address src, address dst) public payable {
        require(msg.value > 0, "Sent zero hbar to this contract");
        src;
        require(IERC20(token).transfer(dst, msg.value), "WHBAR float transfer failed");
        emit Deposit(src, dst, msg.value);
    }

    function withdraw(address src, address dst, uint256 wad) public {
        require(wad > 0, "Attempted to withdraw zero hbar");
        require(IERC20(token).transferFrom(src, address(this), wad), "WHBAR pull failed");
        (bool sent, ) = payable(dst).call{value: wad}("");
        require(sent, "hbar could not be sent");
        emit Withdrawal(src, dst, wad);
    }

    function withdraw(uint256 wad) public {
        withdraw(msg.sender, msg.sender, wad);
    }
}
