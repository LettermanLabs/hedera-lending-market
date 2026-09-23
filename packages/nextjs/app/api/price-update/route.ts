import { createPriceService, HBAR_USD_FEED } from "../../../lib/server/hermes";
import { errorResponse } from "../../../lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const feedId = process.env.NEXT_PUBLIC_PYTH_FEED_ID || HBAR_USD_FEED;
const fetchUpdate = createPriceService({
  baseUrl:
    process.env.HERMES_URL ||
    process.env.NEXT_PUBLIC_HERMES_URL ||
    "https://hermes.pyth.network",
  apiKey: process.env.PYTH_API_KEY || process.env.HERMES_API_KEY,
  feedId,
});

export async function GET(request: Request) {
  try {
    const update = await fetchUpdate(
      new URL(request.url).searchParams.get("feedId") ?? feedId,
    );
    return Response.json(update, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(
      error,
      "Unable to fetch a signed price update. Please retry shortly.",
    );
  }
}
