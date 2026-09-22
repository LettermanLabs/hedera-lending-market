/**
 * Fetches a signed Pyth price update payload from Hermes. The payload is passed to
 * the pool's pull-oracle entry points (borrow / withdraw / liquidate) so the
 * on-chain price is provably fresh.
 */
export async function fetchPriceUpdate(feedId: string): Promise<`0x${string}`[]> {
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`);
  if (!res.ok) throw new Error(`Hermes request failed: ${res.status}`);
  const json = (await res.json()) as { binary: { data: string[] } };
  return json.binary.data.map(d => `0x${d}` as `0x${string}`);
}

export async function fetchHbarUsd(): Promise<number> {
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${process.env.NEXT_PUBLIC_PYTH_FEED_ID ?? "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd"}`);
  const json = (await res.json()) as { parsed: { price: { price: string; expo: number } }[] };
  const p = json.parsed[0].price;
  return Number(p.price) * 10 ** p.expo;
}
