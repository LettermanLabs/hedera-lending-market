import type { Hash } from "viem";
import { appConfig } from "../lib/config";

export function TransactionStatus({
  error,
  message,
  hash,
}: {
  error: string | null;
  message: string | null;
  hash?: Hash;
}) {
  if (!error && !message && !hash) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className={`text-xs leading-relaxed ${error ? "text-red-300" : "text-slate-400"}`}
    >
      {error ?? message}{" "}
      {hash ? (
        <a
          className="text-sky-400 underline"
          href={`${appConfig.hashscan}/transaction/${hash}`}
          target="_blank"
          rel="noreferrer"
        >
          View transaction
        </a>
      ) : null}
    </div>
  );
}
