import assert from "node:assert/strict";
import test from "node:test";
import {
  minimumSwapOutput,
  parsePositiveAmount,
  pythPrice18,
  tinybarToWeibar,
} from "./amounts";

test("100 HBAR deposits send 100e18 weibar while ABI amounts stay 100e8 tinybars", () => {
  const abiAmount = parsePositiveAmount("100", 8, "HBAR");
  assert.equal(abiAmount, 10_000_000_000n);
  assert.equal(tinybarToWeibar(abiAmount), 100_000_000_000_000_000_000n);
  assert.equal(
    tinybarToWeibar(1n),
    10_000_000_000n,
    "one-tinybar oracle fee must survive the relay minimum",
  );
});

test("amount inputs reject values that viem would round or allow accidentally", () => {
  for (const input of ["0", "-1", "1e3", ".", "1.0000001", "NaN", "Infinity"]) {
    assert.throws(() => parsePositiveAmount(input, 6, "USDX"));
  }
  assert.equal(parsePositiveAmount(" 1.234567 ", 6, "USDX"), 1_234_567n);
  assert.throws(() => tinybarToWeibar(-1n));
});

test("Pyth prices and swap minimums preserve integer precision", () => {
  assert.equal(pythPrice18("10000000", -8), 100_000_000_000_000_000n);
  assert.equal(minimumSwapOutput(1_234_567n), 1_197_529n);
  assert.throws(() => pythPrice18("0", -8));
  assert.throws(() => pythPrice18("1", -19));
  assert.throws(() => minimumSwapOutput(1n));
});
