import { configurationError } from "../lib/config";

export function SetupNotice() {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-amber-500/40 bg-amber-500/10 p-8 text-sm leading-relaxed">
      <h2 className="mb-4 text-xl font-bold text-amber-300">
        Configure your testnet market
      </h2>
      {configurationError ? (
        <p role="alert" className="mb-4 text-red-300">
          {configurationError}
        </p>
      ) : null}
      <p className="mb-4 text-slate-300">
        This template ships unconfigured by design. Deploy your own instance to
        Hedera testnet, then configure the integrations:
      </p>
      <ol className="mb-4 list-decimal space-y-2 pl-5 text-slate-300">
        <li>
          Create a testnet account at the{" "}
          <a
            className="underline"
            href="https://portal.hedera.com"
            target="_blank"
            rel="noreferrer"
          >
            Hedera Portal
          </a>{" "}
          and fund it from the faucet, then copy{" "}
          <code className="text-emerald-300">.env.example</code> to{" "}
          <code className="text-emerald-300">.env</code> and fill in your
          credentials.
        </li>
        <li>
          <code className="text-emerald-300">npm run deploy</code> — creates the
          HTS USDX token, deploys the pool, seeds liquidity and creates the HCS
          topic.
        </li>
        <li>
          <code className="text-emerald-300">npm run bootstrap</code> — attempts
          to seed the SaucerSwap WHBAR/USDX pool. The legacy testnet factory is
          unavailable; use the documented fork test to validate liquidation
          swaps.
        </li>
      </ol>
      <p className="mb-4 text-slate-400">
        A working authenticated Hermes endpoint is required for borrowing and
        liquidation. See the README for price-service and optional HCS server
        configuration.
      </p>
      <p className="text-slate-400">
        Then restart <code className="text-emerald-300">npm run dev</code> — the
        app picks up{" "}
        <code className="text-emerald-300">packages/nextjs/.env.local</code>{" "}
        automatically.
      </p>
    </div>
  );
}
