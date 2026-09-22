import type { Metadata } from "next";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hedera Lending Market",
  description:
    "Collateralized lending on Hedera: supply and borrow an HTS stable asset against HBAR collateral, with Pyth pricing, SaucerSwap liquidations and an HCS activity feed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <Providers>
          <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
            <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
              <div className="flex items-center gap-6">
                <Link href="/" className="text-lg font-bold tracking-tight">
                  Hedera <span className="text-emerald-400">Lending Market</span>
                </Link>
                <nav className="hidden gap-4 text-sm text-slate-400 sm:flex">
                  <Link href="/" className="hover:text-slate-100">
                    Market
                  </Link>
                  <Link href="/activity" className="hover:text-slate-100">
                    Activity (HCS)
                  </Link>
                </nav>
              </div>
              <ConnectButton showBalance={false} />
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="border-t border-slate-800 py-6 text-center text-xs text-slate-500">
            Testnet template — HTS · HCS · Pyth · SaucerSwap on Hedera
          </footer>
        </Providers>
      </body>
    </html>
  );
}
