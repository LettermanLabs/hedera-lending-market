"use client";

import { FaucetButton } from "../components/FaucetButton";
import { LiquidationWatch } from "../components/LiquidationWatch";
import { MarketStats } from "../components/MarketStats";
import { PositionPanel } from "../components/PositionPanel";
import { PricePanel } from "../components/PricePanel";
import { SetupNotice } from "../components/SetupNotice";
import { isConfigured } from "../lib/config";

export default function Home() {
  if (!isConfigured) {
    return <SetupNotice />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Market</h1>
          <p className="text-sm text-slate-400">
            Supply USDX to earn interest, or borrow it against HBAR collateral —
            priced by Pyth, settled on Hedera.
          </p>
        </div>
      </div>

      <MarketStats />
      <PricePanel />
      <PositionPanel />
      <LiquidationWatch />
      <FaucetButton />
    </div>
  );
}
