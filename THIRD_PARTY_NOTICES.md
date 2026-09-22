# Third-party notices and source history

The root [MIT license](LICENSE) covers current original LettermanLabs application,
contract and test-harness code. Dependency packages retain their individual licenses.

## Earlier GPL test fixtures

Earlier repository revisions, including `82ac252`, included SaucerSwap / Uniswap V2
derived AMM contracts under `packages/hardhat/contracts/fork/`. Those GPL-3.0 fixtures
have been removed from the current source and replaced by a small MIT test harness.
This does not relicense any historical source copies or earlier revisions.

Historical upstream attribution:

- [SaucerSwap core](https://github.com/saucerswaplabs/saucerswaplabs-core), including
  `UniswapV2Pair.sol`, libraries and interfaces.
- [Uniswap V2 core](https://github.com/Uniswap/v2-core), the antecedent of that AMM.

The prior fixture adapted HTS LP creation and token movement for local emulation.
Its GPL notices continue to apply to those historical files. The full GPL-3.0 text
is retained at [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt) for that history.

The current local harness is not SaucerSwap's deployed implementation. See the
README and fork test for the distinction between local liquidation assertions and
read-only checks against deployed ecosystem contracts.
