import { randomUUID } from "node:crypto";

export const AUDIT_ACTIONS = [
  "request.started",
  "request.completed",
  "hcs.submission.started",
  "hcs.submission.completed",
  "hcs.submission.duplicate",
  "hcs.submission.pending",
] as const;

export interface AuditEvent {
  version: 1;
  event_id: string;
  occurred_at: string;
  request_id: string;
  source: "hedera-lending-market";
  network: "hedera-testnet";
  action: (typeof AUDIT_ACTIONS)[number];
  outcome: "started" | "succeeded" | "rejected" | "failed" | "unknown";
  actor: "anonymous" | "hedera-api";
  route: "/api/activity" | "/api/price-update";
  method: "GET" | "POST";
  status?: number;
  context?: {
    tx_hash: string;
    pool: string;
    account: string;
    topic_id: string;
    sequence?: string;
  };
}

export type AuditInput = Omit<
  AuditEvent,
  "version" | "event_id" | "occurred_at" | "source" | "network"
>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid audit record");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported audit field");
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

/** A closed schema keeps request payloads, credentials and free-form errors out of the ledger. */
export function parseAuditEvent(input: unknown): AuditEvent {
  const value = object(input);
  keys(value, [
    "version",
    "event_id",
    "occurred_at",
    "request_id",
    "source",
    "network",
    "action",
    "outcome",
    "actor",
    "route",
    "method",
    "status",
    "context",
  ]);
  if (
    value.version !== 1 ||
    value.source !== "hedera-lending-market" ||
    value.network !== "hedera-testnet" ||
    !matches(value.event_id, uuid) ||
    !matches(value.request_id, uuid) ||
    typeof value.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    new Date(value.occurred_at).toISOString() !== value.occurred_at ||
    !AUDIT_ACTIONS.includes(value.action as AuditEvent["action"]) ||
    !["started", "succeeded", "rejected", "failed", "unknown"].includes(
      String(value.outcome),
    ) ||
    !["anonymous", "hedera-api"].includes(String(value.actor)) ||
    !["/api/activity", "/api/price-update"].includes(String(value.route)) ||
    !["GET", "POST"].includes(String(value.method))
  )
    throw new Error("Invalid audit record");

  const hcs = String(value.action).startsWith("hcs.");
  if (hcs) {
    if (
      value.actor !== "hedera-api" ||
      value.route !== "/api/activity" ||
      value.method !== "POST" ||
      value.status !== undefined
    )
      throw new Error("Invalid HCS audit record");
    const context = object(value.context);
    keys(context, ["tx_hash", "pool", "account", "topic_id", "sequence"]);
    if (
      !matches(context.tx_hash, hash) ||
      !matches(context.pool, address) ||
      !matches(context.account, address) ||
      !matches(context.topic_id, /^0\.0\.\d{1,20}$/) ||
      (context.sequence !== undefined &&
        !matches(context.sequence, /^[1-9]\d{0,19}$/))
    )
      throw new Error("Invalid audit transaction reference");
    const expected =
      value.action === "hcs.submission.started"
        ? ["started"]
        : value.action === "hcs.submission.pending"
          ? ["unknown"]
          : value.action === "hcs.submission.duplicate"
            ? ["succeeded"]
            : ["succeeded", "unknown"];
    if (
      !expected.includes(String(value.outcome)) ||
      (value.outcome === "succeeded" && context.sequence === undefined) ||
      (value.outcome !== "succeeded" && context.sequence !== undefined)
    )
      throw new Error("Invalid audit outcome");
  } else {
    if (
      value.actor !== "anonymous" ||
      value.context !== undefined ||
      (value.route === "/api/price-update" && value.method !== "GET")
    )
      throw new Error("Invalid request audit record");
    if (value.action === "request.started") {
      if (value.outcome !== "started" || value.status !== undefined)
        throw new Error("Invalid request audit outcome");
    } else {
      if (
        !Number.isInteger(value.status) ||
        Number(value.status) < 200 ||
        Number(value.status) > 599
      )
        throw new Error("Invalid audit HTTP status");
      const outcome =
        Number(value.status) < 400
          ? "succeeded"
          : Number(value.status) < 500
            ? "rejected"
            : "failed";
      if (value.outcome !== outcome)
        throw new Error("Invalid request audit outcome");
    }
  }
  // Return a plain copy so later callers cannot mutate a queued record.
  return JSON.parse(JSON.stringify(value)) as AuditEvent;
}

export function createAuditEvent(input: AuditInput): AuditEvent {
  return parseAuditEvent({
    ...input,
    version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: "hedera-lending-market",
    network: "hedera-testnet",
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Invalid audit value");
  return encoded;
}

/** Display text is derived from stored facts, never supplied by the request. */
export function formatAuditEvent(event: AuditEvent): string {
  switch (event.action) {
    case "request.started":
      return `${event.method} ${event.route} received.`;
    case "request.completed":
      return `${event.method} ${event.route} returned ${event.status}.`;
    case "hcs.submission.started":
      return "HCS submission started for a verified pool transaction.";
    case "hcs.submission.completed":
      return event.outcome === "succeeded"
        ? `HCS submission confirmed at sequence ${event.context!.sequence}.`
        : "HCS submission outcome is unknown. Reconciliation is required.";
    case "hcs.submission.duplicate":
      return "Transaction was already recorded. No HCS submission was repeated.";
    case "hcs.submission.pending":
      return "An earlier submission is pending reconciliation. No retry was sent.";
  }
}
