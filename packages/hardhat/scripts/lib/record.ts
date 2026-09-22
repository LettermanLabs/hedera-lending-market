import * as fs from "fs";
import * as path from "path";

export interface DeploymentStep {
  status: "pending" | "complete";
  transactionHash?: string;
  transactionId?: string;
}

export interface DeploymentRecord {
  version?: 2;
  network: string;
  operator?: string;
  artifactHash?: string;
  lendingPool?: string;
  lendingPoolId?: string;
  usdxTokenId: string;
  usdxEvm: string;
  whbar: string;
  pyth: string;
  hbarUsdPriceId: string;
  saucerSwapRouter: string;
  hcsTopicId?: string;
  hcsRestricted?: boolean;
  ammPair?: string;
  steps?: Record<string, DeploymentStep>;
  deployedAt: string;
}

const NEXTJS_ENV = path.join(__dirname, "../../../nextjs/.env.local");
const DEPLOYMENTS_DIR = path.join(__dirname, "../../deployments");

/** Update deployment addresses, retaining unrelated settings, comments and secrets. */
export function mergeEnv(
  existing: string,
  values: Record<string, string>,
  defaults: Record<string, string> = {},
): string {
  const remaining = { ...values };
  const seen = new Set<string>();
  const lines = existing.split(/\r?\n/).filter((line, index, all) => index !== all.length - 1 || line !== "");
  const result = lines.flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) return [line];
    const key = match[1];
    seen.add(key);
    if (!(key in values)) return [line];
    if (!(key in remaining)) return []; // collapse duplicate generated addresses
    delete remaining[key];
    return [`${key}=${values[key]}`];
  });
  for (const [key, value] of Object.entries({ ...defaults, ...remaining })) {
    if (!(key in values) && seen.has(key)) continue;
    result.push(`${key}=${value}`);
  }
  return result.join("\n") + "\n";
}

function atomicWrite(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** A created but unseeded pair must never enable the frontend swap route. */
export function deploymentPublicEnv(record: DeploymentRecord): Record<string, string> {
  return {
    NEXT_PUBLIC_NETWORK: record.network,
    NEXT_PUBLIC_CHAIN_ID: "296",
    NEXT_PUBLIC_LENDING_POOL: record.lendingPool ?? "",
    NEXT_PUBLIC_USDX_TOKEN_ID: record.usdxTokenId,
    NEXT_PUBLIC_USDX_EVM: record.usdxEvm,
    NEXT_PUBLIC_WHBAR: record.whbar,
    NEXT_PUBLIC_PYTH: record.pyth,
    NEXT_PUBLIC_PYTH_FEED_ID: record.hbarUsdPriceId,
    NEXT_PUBLIC_SAUCERSWAP_ROUTER: record.saucerSwapRouter,
    NEXT_PUBLIC_HCS_TOPIC_ID: record.hcsTopicId ?? "",
    NEXT_PUBLIC_AMM_PAIR: record.steps?.ammSeed?.status === "complete" ? (record.ammPair ?? "") : "",
  };
}

export function saveDeployment(record: DeploymentRecord): void {
  atomicWrite(path.join(DEPLOYMENTS_DIR, `${record.network}.json`), JSON.stringify(record, null, 2) + "\n");
  if (!record.lendingPool) return;
  const values = deploymentPublicEnv(record);
  const existing = fs.existsSync(NEXTJS_ENV) ? fs.readFileSync(NEXTJS_ENV, "utf8") : "";
  atomicWrite(
    NEXTJS_ENV,
    mergeEnv(existing, values, {
      NEXT_PUBLIC_RPC_URL: "https://testnet.hashio.io/api",
      NEXT_PUBLIC_MIRROR_NODE: "https://testnet.mirrornode.hedera.com",
    }),
  );
}

export function loadDeployment(network = "hedera-testnet"): DeploymentRecord | null {
  const file = path.join(DEPLOYMENTS_DIR, `${network}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentRecord;
}

/** Persist before submitting; uncertain operations must never be repeated blindly. */
export function beginStep(record: DeploymentRecord, name: string, persist = saveDeployment) {
  record.steps ??= {};
  if (record.steps[name]?.status === "complete") return false;
  if (record.steps[name]) {
    throw new Error(
      `Deployment step '${name}' has an unresolved submission. Verify its transaction on Hashscan before reconciling deployments/${record.network}.json; do not delete the journal or resend blindly.`,
    );
  }
  record.steps[name] = { status: "pending" };
  persist(record);
  return true;
}

export function completeStep(record: DeploymentRecord, name: string, persist = saveDeployment) {
  record.steps ??= {};
  record.steps[name] = { ...record.steps[name], status: "complete" };
  persist(record);
}
