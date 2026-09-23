import { pythPrice18 } from "./amounts";

export interface PriceSnapshot {
  updateData: `0x${string}`[];
  price18: bigint;
  publishTime: number;
}

/** Authenticated Hermes requests stay on the server; browser code never sees API keys. */
export async function fetchPriceSnapshot(
  feedId: string,
): Promise<PriceSnapshot> {
  const res = await fetch(
    `/api/price-update?feedId=${encodeURIComponent(feedId)}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : `Price update unavailable (${res.status}).`,
    );
  }
  const data = json.binary?.data;
  if (
    !Array.isArray(data) ||
    data.length === 0 ||
    !data.every(
      (item: unknown) =>
        typeof item === "string" && /^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(item),
    )
  ) {
    throw new Error("The price service returned an invalid signed update.");
  }
  const parsed = Array.isArray(json.parsed)
    ? json.parsed.find(
        (item: { id?: string }) =>
          item.id?.replace(/^0x/, "").toLowerCase() ===
          feedId.replace(/^0x/, "").toLowerCase(),
      )
    : undefined;
  const price = parsed?.price;
  const publishTime = price?.publish_time;
  if (
    !price ||
    typeof price.price !== "string" ||
    typeof publishTime !== "number" ||
    !Number.isFinite(publishTime)
  ) {
    throw new Error(
      "The price service did not return the requested HBAR feed.",
    );
  }
  if (
    publishTime < Math.floor(Date.now() / 1000) - 120 ||
    publishTime > Math.floor(Date.now() / 1000) + 30
  ) {
    throw new Error(
      "The HBAR price update is stale. Try again when the oracle is available.",
    );
  }
  return {
    updateData: data.map(
      (item: string) => `0x${item.replace(/^0x/, "")}` as `0x${string}`,
    ),
    price18: pythPrice18(price.price, price.expo),
    publishTime,
  };
}

export async function fetchPriceUpdate(
  feedId: string,
): Promise<`0x${string}`[]> {
  return (await fetchPriceSnapshot(feedId)).updateData;
}
