import { formatAuditEvent } from "../../packages/nextjs/lib/server/audit-event";
import { type AuditRecord } from "./journal";

export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

const columns = [
  "sequence",
  "recorded_at",
  "occurred_at",
  "event_id",
  "request_id",
  "actor",
  "action",
  "outcome",
  "summary",
  "route",
  "method",
  "http_status",
  "transaction_hash",
  "pool",
  "account",
  "topic_id",
  "hcs_sequence",
  "record_hash",
];
export function csvHeader(): string {
  return columns.map(csvCell).join(",") + "\r\n";
}
export function csvRecord(record: AuditRecord): string {
  const event = record.event;
  return (
    [
      record.sequence,
      record.recorded_at,
      event.occurred_at,
      event.event_id,
      event.request_id,
      event.actor,
      event.action,
      event.outcome,
      formatAuditEvent(event),
      event.route,
      event.method,
      event.status,
      event.context?.tx_hash,
      event.context?.pool,
      event.context?.account,
      event.context?.topic_id,
      event.context?.sequence,
      record.hash,
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}
