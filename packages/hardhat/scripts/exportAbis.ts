/**
 * Exports the compiled LendingPool ABI as a TypeScript module for the frontend.
 * Run after compile: npm run export-abis -w @sh/hardhat
 */
import * as fs from "fs";
import * as path from "path";

const ARTIFACT = path.join(__dirname, "../artifacts/contracts/LendingPool.sol/LendingPool.json");
const OUT = path.join(__dirname, "../../nextjs/contracts/abis/LendingPool.ts");

const ERC20_OUT = path.join(__dirname, "../../nextjs/contracts/abis/erc20.ts");

function main() {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `export const LendingPoolAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`);
  fs.writeFileSync(ERC20_OUT, 'export { erc20Abi } from "viem";\n');
  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${ERC20_OUT}`);
}

main();
