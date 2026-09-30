import { randomUUID } from "node:crypto";
import { getAuditWriter, type AuditWriter } from "./audit-client";
import type { AuditEvent, AuditInput } from "./audit-event";

type Detail = Omit<AuditInput, "request_id" | "route" | "method">;

export interface AuditRouteContext {
  requestId: string;
  record: (detail: Detail) => Promise<void>;
}

/** A completed action must not be retried because its audit delivery failed. */
export async function recordAuditOutcome(
  context: AuditRouteContext | undefined,
  detail: Detail,
) {
  if (!context) return;
  try {
    await context.record(detail);
  } catch {
    console.error(
      JSON.stringify({
        event: "audit.outcome_write_failed",
        request_id: context.requestId,
        action: detail.action,
      }),
    );
  }
}

export function withAuditRoute(
  route: AuditEvent["route"],
  method: AuditEvent["method"],
  handler: (
    request: Request,
    audit: AuditRouteContext,
  ) => Promise<Response> | Response,
  writer: () => AuditWriter = getAuditWriter,
) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    let audit: AuditRouteContext;
    try {
      const sink = writer();
      audit = {
        requestId,
        record: (detail) =>
          sink.record({ ...detail, request_id: requestId, route, method }),
      };
      await audit.record({
        action: "request.started",
        outcome: "started",
        actor: "anonymous",
      });
    } catch {
      console.error(
        JSON.stringify({
          event: "audit.request_write_failed",
          request_id: requestId,
        }),
      );
      return Response.json(
        {
          ok: false,
          error: "Security audit storage is unavailable. Retry shortly.",
        },
        {
          status: 503,
          headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
        },
      );
    }

    let response: Response;
    try {
      response = await handler(request, audit);
    } catch {
      response = Response.json(
        { ok: false, error: "The request could not be completed." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    await recordAuditOutcome(audit, {
      action: "request.completed",
      outcome:
        response.status < 400
          ? "succeeded"
          : response.status < 500
            ? "rejected"
            : "failed",
      actor: "anonymous",
      status: response.status,
    });
    response.headers.set("X-Request-Id", requestId);
    return response;
  };
}
