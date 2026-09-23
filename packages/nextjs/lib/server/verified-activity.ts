import { decodeEventLog, parseAbi, type Hex } from "viem";
import { HttpError } from "./http";

const events = parseAbi([
  "event CollateralDeposited(address indexed account, uint256 amount)",
  "event CollateralWithdrawn(address indexed account, uint256 amount)",
  "event Supplied(address indexed account, uint256 amount)",
  "event SupplyWithdrawn(address indexed account, uint256 amount)",
  "event Borrowed(address indexed account, uint256 amount)",
  "event Repaid(address indexed account, uint256 amount)",
  "event FaucetClaimed(address indexed account, uint256 amount)",
  "event Liquidated(address indexed borrower, address indexed liquidator, uint256 repaid, uint256 whbarSeized, uint256 usdxRecovered)",
]);

export interface VerifiedActivity {
  version: 1;
  chainId: 296;
  pool: string;
  txHash: string;
  at: string;
  type: string;
  account: string;
  amount: string;
  logIndex: number;
  liquidator?: string;
}

/** Only mirror successful direct pool transactions; event data is never supplied by the caller. */
export function verifyActivity(
  input: unknown,
  hash: string,
  pool: string,
  now = Date.now(),
): VerifiedActivity {
  const result = input as {
    result?: string;
    hash?: string;
    to?: string;
    timestamp?: string;
    logs?: { address: string; data: Hex; topics: Hex[]; index: number }[];
  } | null;
  if (
    result?.result !== "SUCCESS" ||
    result.hash?.toLowerCase() !== hash.toLowerCase() ||
    result.to?.toLowerCase() !== pool.toLowerCase()
  )
    throw new HttpError(
      422,
      "This is not a successful transaction to the configured pool.",
    );
  const timestamp = result.timestamp;
  if (!timestamp || !/^\d+\.\d+$/.test(timestamp))
    throw new HttpError(502, "The mirror node returned an invalid timestamp.");
  const age = now / 1000 - Number(timestamp);
  if (age < -30 || age > 86400)
    throw new HttpError(
      422,
      "Only confirmed pool activity from the last 24 hours can be mirrored.",
    );
  const verified: VerifiedActivity[] = [];
  for (const log of result.logs ?? []) {
    if (log.address?.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: events,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      const args = decoded.args;
      verified.push({
        version: 1,
        chainId: 296,
        pool: pool.toLowerCase(),
        txHash: hash.toLowerCase(),
        at: timestamp,
        type: decoded.eventName,
        logIndex: log.index,
        account: "account" in args ? args.account : args.borrower,
        amount: ("amount" in args ? args.amount : args.repaid).toString(),
        ...("liquidator" in args ? { liquidator: args.liquidator } : {}),
      });
    } catch {
      /* Skip unrelated events (such as the Pyth price update). */
    }
  }
  if (verified.length !== 1)
    throw new HttpError(
      422,
      "Expected exactly one recognized pool action in the transaction.",
    );
  return verified[0];
}
