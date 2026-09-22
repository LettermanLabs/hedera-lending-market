import * as fs from "fs";
import * as path from "path";

export interface DeploymentRecord {
  network: string;
  lendingPool: string;
  usdxTokenId: string;
  usdxEvm: string;
  whbar: string;
  pyth: string;
  hbarUsdPriceId: string;
  saucerSwapRouter: string;
  hcsTopicId?: string;
  ammPair?: string;
  deployedAt: string;
}

const NEXTJS_ENV = path.join(__dirname, "../../../nextjs/.env.local");
const DEPLOYMENTS_DIR = path.join(__dirname, "../../deployments");

export function saveDeployment(record: DeploymentRecord): void {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEPLOYMENTS_DIR, `${record.network}.json`), JSON.stringify(record, null, 2));

  const env = [
    `NEXT_PUBLIC_NETWORK=${record.network}`,
    `NEXT_PUBLIC_CHAIN_ID=296`,
    `NEXT_PUBLIC_RPC_URL=https://testnet.hashio.io/api`,
    `NEXT_PUBLIC_MIRROR_NODE=https://testnet.mirrornode.hedera.com`,
    `NEXT_PUBLIC_LENDING_POOL=${record.lendingPool}`,
    `NEXT_PUBLIC_USDX_TOKEN_ID=${record.usdxTokenId}`,
    `NEXT_PUBLIC_USDX_EVM=${record.usdxEvm}`,
    `NEXT_PUBLIC_WHBAR=${record.whbar}`,
    `NEXT_PUBLIC_PYTH=${record.pyth}`,
    `NEXT_PUBLIC_PYTH_FEED_ID=${record.hbarUsdPriceId}`,
    `NEXT_PUBLIC_SAUCERSWAP_ROUTER=${record.saucerSwapRouter}`,
    record.hcsTopicId ? `NEXT_PUBLIC_HCS_TOPIC_ID=${record.hcsTopicId}` : null,
    record.ammPair ? `NEXT_PUBLIC_AMM_PAIR=${record.ammPair}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(NEXTJS_ENV, env + "\n");
}

export function loadDeployment(network = "hedera-testnet"): DeploymentRecord | null {
  const file = path.join(DEPLOYMENTS_DIR, `${network}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentRecord;
}
