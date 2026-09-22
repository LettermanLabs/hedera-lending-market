import { HttpError, readJson } from "./http";

export const HBAR_USD_FEED =
  "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";
export interface PriceUpdate {
  binary: { encoding: "hex"; data: string[] };
  parsed: {
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }[];
}

export function validatePriceUpdate(
  input: unknown,
  feed: string,
  now = Date.now(),
): PriceUpdate {
  const data = input as Partial<PriceUpdate> | null;
  if (
    !data ||
    data.binary?.encoding !== "hex" ||
    !Array.isArray(data.binary.data) ||
    data.binary.data.length < 1 ||
    data.binary.data.length > 8 ||
    !data.binary.data.every(
      (value) =>
        typeof value === "string" && /^(?:[0-9a-fA-F]{2})+$/.test(value),
    ) ||
    !Array.isArray(data.parsed)
  )
    throw new HttpError(502, "Hermes returned an invalid signed update.");
  const entry = data.parsed.find(
    (item) =>
      item?.id?.replace(/^0x/, "").toLowerCase() ===
      feed.replace(/^0x/, "").toLowerCase(),
  );
  const price = entry?.price;
  if (
    !price ||
    !/^[0-9]+$/.test(price.price) ||
    BigInt(price.price) <= 0n ||
    !/^[0-9]+$/.test(price.conf) ||
    !Number.isInteger(price.expo) ||
    price.expo < -18 ||
    price.expo > 0 ||
    !Number.isInteger(price.publish_time)
  )
    throw new HttpError(
      502,
      "Hermes did not return the configured HBAR/USD price.",
    );
  const age = now / 1000 - price.publish_time;
  if (age > 110 || age < -10)
    throw new HttpError(
      503,
      "The signed HBAR/USD update is stale. Retry when the oracle is available.",
    );
  return {
    binary: { encoding: "hex", data: data.binary.data },
    parsed: [
      {
        id: entry!.id,
        price: {
          price: price.price,
          conf: price.conf,
          expo: price.expo,
          publish_time: price.publish_time,
        },
      },
    ],
  };
}

export function createPriceService(options: {
  baseUrl: string;
  feedId: string;
  apiKey?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { value: PriceUpdate; at: number } | undefined;
  let pending: Promise<PriceUpdate> | undefined;
  return async (feedId: string): Promise<PriceUpdate> => {
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(feedId) ||
      feedId.toLowerCase() !== options.feedId.toLowerCase()
    )
      throw new HttpError(
        400,
        "Only the configured HBAR/USD feed is available.",
      );
    if (cached && now() - cached.at < 2000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const url = new URL(
        `${options.baseUrl.replace(/\/$/, "")}/v2/updates/price/latest`,
      );
      if (
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          ))
      )
        throw new HttpError(
          503,
          "Configure HERMES_URL with an HTTPS provider or local Hermes instance.",
        );
      url.searchParams.set("ids[]", feedId);
      url.searchParams.set("encoding", "hex");
      url.searchParams.set("parsed", "true");
      const response = await fetcher(url, {
        headers: options.apiKey
          ? { Authorization: `Bearer ${options.apiKey}` }
          : {},
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403)
        throw new HttpError(
          503,
          "Pyth authentication is required. Configure PYTH_API_KEY on the server, or HERMES_URL for your provider.",
        );
      if (!response.ok)
        throw new HttpError(
          503,
          "The signed-price provider is unavailable. Please retry shortly.",
        );
      const value = validatePriceUpdate(
        await readJson(response.body, 256 * 1024),
        feedId,
        now(),
      );
      cached = { value, at: now() };
      return value;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
