import { ActivityStore } from "./activity-store";
import { errorResponse, HttpError, readJson } from "./http";
import { verifyActivity, type VerifiedActivity } from "./verified-activity";

export interface ActivityDependencies {
  pool: string;
  topicId: string;
  mirrorNode: string;
  store: ActivityStore;
  submitKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
  prepare: (message: VerifiedActivity) => {
    id: string;
    send: () => Promise<string>;
  };
}

export function createActivityHandler(deps: ActivityDependencies) {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  let requestWindow = 0;
  let requests = 0;
  return async (request: Request): Promise<Response> => {
    try {
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== new URL(request.url).origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new HttpError(
          403,
          "Cross-site activity reports are not allowed.",
        );
      const window = Math.floor(now() / 60_000);
      if (window !== requestWindow) {
        requestWindow = window;
        requests = 0;
      }
      if (++requests > 90)
        throw new HttpError(
          429,
          "Too many activity requests. Retry in a minute.",
        );
      let body: unknown;
      try {
        body = await readJson(request.body, 1024);
      } catch {
        throw new HttpError(
          400,
          "Provide a small JSON object containing only txHash.",
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "txHash")
      )
        throw new HttpError(
          400,
          "Only txHash is accepted; activity is derived from confirmed pool events.",
        );
      const hash = (body as { txHash?: unknown }).txHash;
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
        throw new HttpError(400, "A valid transaction hash is required.");
      const txHash = hash.toLowerCase();
      const response = await fetcher(
        `${deps.mirrorNode}/api/v1/contracts/results/${txHash}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
      if (response.status === 404)
        throw new HttpError(
          409,
          "The mirror node has not indexed this transaction yet.",
        );
      if (!response.ok)
        throw new HttpError(
          503,
          "The mirror node is unavailable. Retry shortly.",
        );
      const message = verifyActivity(
        await readJson(response.body, 256 * 1024),
        txHash,
        deps.pool,
        now(),
      );
      const topicResponse = await fetcher(
        `${deps.mirrorNode}/api/v1/topics/${deps.topicId}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
      if (!topicResponse.ok)
        throw new HttpError(503, "Cannot verify the HCS topic configuration.");
      const topic = (await readJson(topicResponse.body, 16384)) as {
        deleted?: boolean;
        submit_key?: { key?: string };
      };
      if (
        topic.deleted ||
        topic.submit_key?.key?.toLowerCase() !== deps.submitKey.toLowerCase()
      )
        throw new HttpError(
          503,
          "Configure a restricted HCS topic with this operator's submit key. Redeploy legacy open topics.",
        );
      const reservation = await deps.store.reserve(txHash, now());
      if (reservation.state === "submitted")
        return Response.json({
          ok: true,
          duplicate: true,
          sequence: reservation.sequence,
        });
      if (reservation.state === "pending")
        throw new HttpError(
          503,
          "This report is pending reconciliation. It will not be submitted twice; inspect the server activity journal.",
        );
      if (reservation.state === "limited")
        throw new HttpError(
          429,
          "The hourly HCS submission budget is reached. Retry next hour.",
        );
      const submission = deps.prepare(message);
      await deps.store.save(txHash, {
        state: "pending",
        transactionId: submission.id,
      });
      const sequence = await submission.send();
      await deps.store.save(txHash, { state: "submitted", sequence });
      return Response.json({ ok: true, sequence });
    } catch (error) {
      return errorResponse(
        error,
        "Activity could not be confirmed. Unknown submission outcomes are retained in the server journal and are not retried automatically.",
      );
    }
  };
}
