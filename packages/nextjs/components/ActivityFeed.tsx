"use client";

import { useCallback, useEffect, useState } from "react";
import { appConfig } from "../lib/config";
import { fetchTopicMessages } from "../lib/mirror";
import type { ActivityItem } from "../lib/mirror";

export function ActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const topicId = appConfig.hcsTopicId;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!topicId) return;
      setLoading(true);
      try {
        const messages = await fetchTopicMessages(
          appConfig.mirrorNode,
          topicId,
          signal,
        );
        if (signal?.aborted) return;
        setItems(messages);
        setError(null);
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [topicId],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 10_000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load]);

  if (!topicId) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
        No HCS topic configured. Run{" "}
        <code className="text-emerald-300">npm run deploy</code> to create the
        activity topic, then restart the dev server.
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">HCS activity feed</h3>
          <p className="text-xs text-slate-500">
            Topic {topicId} — the latest 50 activity messages. The app submits
            verified, confirmed pool transactions; actions sent outside this app
            may be absent.
          </p>
        </div>
        <button
          onClick={() => {
            void load();
          }}
          disabled={loading}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error ? <p className="mb-3 text-xs text-red-400">{error}</p> : null}

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">
          {loading
            ? "Loading activity…"
            : error
              ? "Activity is unavailable."
              : "No messages yet — confirmed market actions appear here when HCS mirroring is configured."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4">#</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Account</th>
                <th className="py-2 pr-4">Details</th>
                <th className="py-2">Consensus time</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.sequence}
                  className="border-b border-slate-800/50"
                >
                  <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                    {item.sequence}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-emerald-300">
                      {item.type}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {item.account ? `${item.account.slice(0, 8)}…` : "—"}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">
                    {item.txHash ? (
                      <a
                        href={`${appConfig.hashscan}/transaction/${item.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline"
                      >
                        {item.txHash.slice(0, 12)}…
                      </a>
                    ) : (
                      (item.amount ?? "—")
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs text-slate-500">
                    {item.at}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
