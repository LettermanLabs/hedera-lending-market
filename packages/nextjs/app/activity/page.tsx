"use client";

import { ActivityFeed } from "../../components/ActivityFeed";
import { appConfig } from "../../lib/config";

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity</h1>
        <p className="text-sm text-slate-400">
          An auditable, consensus-timestamped feed of market activity, mirrored
          to Hedera Consensus Service topic{" "}
          <span className="font-mono text-emerald-300">
            {appConfig.hcsTopicId ?? "not deployed"}
          </span>{" "}
          and read back through the mirror node — no wallet required.
        </p>
      </div>
      <ActivityFeed />
    </div>
  );
}
