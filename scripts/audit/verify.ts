import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../packages/nextjs/lib/server/audit-event";
import { csvHeader, csvRecord } from "./export";
import {
  JOURNAL_NAME,
  parseCheckpoint,
  validateSecret,
  verifyJournal,
  type AuditRecord,
} from "./journal";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["verify", "export", "checkpoint"].includes(command ?? ""))
    throw new Error(
      "Usage: verify.ts verify|export|checkpoint [--file absolute-path] [--checkpoint absolute-path] [--format csv|jsonl]",
    );
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--file", "--checkpoint", "--format"].includes(name) ||
      !value ||
      value.startsWith("--") ||
      options.has(name)
    )
      throw new Error("Invalid audit command options.");
    options.set(name, value);
  }
  const directory = process.env.AUDIT_LOG_DIR;
  const filename =
    options.get("--file") ??
    (directory ? path.join(directory, JOURNAL_NAME) : "");
  if (!path.isAbsolute(filename))
    throw new Error("An absolute journal path is required.");
  const checkpointPath = options.get("--checkpoint");
  if (checkpointPath && !path.isAbsolute(checkpointPath))
    throw new Error("An absolute checkpoint path is required.");
  const checkpoint = checkpointPath
    ? parseCheckpoint(JSON.parse(await readFile(checkpointPath, "utf8")))
    : undefined;
  const signingKey = validateSecret(
    process.env.AUDIT_SIGNING_KEY,
    "AUDIT_SIGNING_KEY",
  );
  const format = options.get("--format") ?? "jsonl";
  if (
    !["csv", "jsonl"].includes(format) ||
    (command !== "export" && options.has("--format"))
  )
    throw new Error("Invalid export format.");
  const records: AuditRecord[] = [];
  const result = await verifyJournal(filename, signingKey, {
    checkpoint,
    onRecord:
      command === "export" ? (record) => records.push(record) : undefined,
  });
  // No rows are emitted until the entire source has passed verification.
  if (command === "export") {
    if (format === "csv") process.stdout.write(csvHeader());
    for (const record of records)
      process.stdout.write(
        format === "csv" ? csvRecord(record) : canonicalJson(record) + "\n",
      );
  } else if (command === "checkpoint")
    process.stdout.write(canonicalJson(result.checkpoint) + "\n");
  else
    process.stdout.write(
      `Verified ${result.records} audit records. Head: ${result.checkpoint.hash}\n`,
    );
}

main().catch(() => {
  console.error(
    "Audit inspection failed. Check the journal, signing key, permissions, checkpoint and command options.",
  );
  process.exitCode = 1;
});
