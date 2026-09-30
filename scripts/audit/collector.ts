import { AuditJournal, validateSecret } from "./journal";
import { createCollector } from "./server";

async function main() {
  const token = validateSecret(
    process.env.AUDIT_COLLECTOR_TOKEN,
    "AUDIT_COLLECTOR_TOKEN",
  );
  const signingKey = validateSecret(
    process.env.AUDIT_SIGNING_KEY,
    "AUDIT_SIGNING_KEY",
  );
  if (token === signingKey)
    throw new Error("Writer and signing credentials must differ.");
  const directory = process.env.AUDIT_LOG_DIR;
  if (!directory) throw new Error("AUDIT_LOG_DIR is required.");
  const host = process.env.AUDIT_COLLECTOR_HOST ?? "127.0.0.1";
  const port = Number(process.env.AUDIT_COLLECTOR_PORT ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid collector port.");
  const journal = await AuditJournal.open({ directory, signingKey });
  const server = createCollector({ journal, token });
  const shutdown = () => {
    server.close(() => {
      void journal.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("error", () => {
    void journal.close().finally(() => {
      console.error("Audit collector could not start.");
      process.exitCode = 1;
    });
  });
  server.listen(port, host, () => console.log("Audit collector is listening."));
}

main().catch(() => {
  console.error(
    "Audit collector could not start. Check private configuration, file permissions, writer lock and journal integrity.",
  );
  process.exitCode = 1;
});
