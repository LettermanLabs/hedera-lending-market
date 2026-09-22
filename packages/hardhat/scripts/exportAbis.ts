/**
 * Exports the compiled LendingPool ABI as a TypeScript module for the frontend.
 * Run after compile: npm run export-abis -w @sh/hardhat
 */
import * as fs from "fs";
import * as path from "path";

const ARTIFACT = path.join(__dirname, "../artifacts/contracts/LendingPool.sol/LendingPool.json");
const OUT = path.join(__dirname, "../../nextjs/contracts/abis/LendingPool.ts");

const ERC20_OUT = path.join(__dirname, "../../nextjs/contracts/abis/erc20.ts");

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

function main() {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `export const LendingPoolAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`);
  fs.writeFileSync(ERC20_OUT, `export const erc20Abi = ${JSON.stringify(ERC20_ABI, null, 2)} as const;\n`);
  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${ERC20_OUT}`);
}

main();
