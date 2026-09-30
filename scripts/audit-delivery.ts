import { getAuditWriter } from "../packages/nextjs/lib/server/audit-client";

async function main() {
  if (process.argv.slice(2).some((argument) => argument !== "--once")) {
    console.error("Usage: npm run audit:deliver -- [--once]");
    process.exitCode = 2;
    return;
  }
  if (process.env.AUDIT_MODE !== "required") {
    console.error("Audit delivery requires AUDIT_MODE=required.");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await getAuditWriter().flush();
    console.log(JSON.stringify(result));
    if (result.pending > 0) process.exitCode = 1;
  } catch {
    console.error(
      "Audit delivery failed. Check collector availability, outbox access, and configuration.",
    );
    process.exitCode = 1;
  }
}

void main();
