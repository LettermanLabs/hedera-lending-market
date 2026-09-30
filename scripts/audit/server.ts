import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { parseAuditEvent } from "../../packages/nextjs/lib/server/audit-event";
import {
  type AuditJournal,
  DuplicateEventError,
  validateSecret,
} from "./journal";

function respond(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(JSON.stringify(body));
}

export function createCollector(options: {
  journal: AuditJournal;
  token: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}) {
  validateSecret(options.token, "AUDIT_COLLECTOR_TOKEN");
  const tokenDigest = createHash("sha256").update(options.token).digest();
  const maxBodyBytes = options.maxBodyBytes ?? 4096;
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > 4096 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new Error("Invalid collector limits.");
  const server = createServer(
    {
      maxHeaderSize: 8192,
      requestTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    },
    async (request, response) => {
      if (request.url === "/health" && request.method === "GET") {
        respond(response, options.journal.available ? 200 : 503, {
          status: options.journal.available ? "ok" : "unavailable",
        });
        return;
      }
      if (request.url !== "/v1/events") {
        respond(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        respond(response, 405, { error: "method_not_allowed" });
        return;
      }
      const authorization = request.headers.authorization;
      if (
        request.headersDistinct.authorization?.length !== 1 ||
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer ") ||
        !timingSafeEqual(
          tokenDigest,
          createHash("sha256").update(authorization.slice(7)).digest(),
        )
      ) {
        respond(response, 401, { error: "unauthorized" });
        return;
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers["content-type"] ?? "",
        )
      ) {
        respond(response, 415, { error: "unsupported_media_type" });
        return;
      }
      if (
        request.headers["content-encoding"] &&
        request.headers["content-encoding"] !== "identity"
      ) {
        respond(response, 415, { error: "unsupported_media_type" });
        return;
      }
      const declaredLength = request.headers["content-length"];
      if (declaredLength && Number(declaredLength) > maxBodyBytes) {
        respond(response, 413, { error: "body_too_large" });
        return;
      }
      const timer = setTimeout(() => {
        if (!response.headersSent)
          respond(response, 408, { error: "request_timeout" });
        request.destroy();
      }, timeoutMs);
      timer.unref();
      let bytes = 0;
      const chunks: Buffer[] = [];
      let event;
      try {
        for await (const chunk of request.iterator({
          destroyOnReturn: false,
        })) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > maxBodyBytes) {
            respond(response, 413, { error: "body_too_large" });
            return;
          }
          chunks.push(data);
        }
        event = parseAuditEvent(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
      } catch {
        if (!response.headersSent && !response.destroyed)
          respond(response, 400, { error: "invalid_event" });
        return;
      } finally {
        clearTimeout(timer);
      }
      try {
        const result = await options.journal.append(event);
        respond(response, result.duplicate ? 200 : 201, {
          ok: true,
          event_id: event.event_id,
          accepted: true,
          duplicate: result.duplicate,
          sequence: result.record.sequence,
          hash: result.record.hash,
        });
      } catch (error) {
        if (!(error instanceof DuplicateEventError))
          console.error("audit collector.write_failed");
        respond(response, error instanceof DuplicateEventError ? 409 : 503, {
          error:
            error instanceof DuplicateEventError
              ? "event_conflict"
              : "collector_unavailable",
        });
      }
    },
  );
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  return server;
}
