# Private audit log

The audit collector records server requests and HCS submission outcomes. It runs
separately from the Next.js app and stores its ledger outside the application
directory. It does not publish records to GitHub, HCS, or the activity feed.

## Recorded events

| Event                       | Recorded facts                                                 |
| --------------------------- | -------------------------------------------------------------- |
| Request received            | UTC time, server request ID, route and method                  |
| Request completed           | Request ID, HTTP status and outcome                            |
| HCS submission started      | Verified transaction hash, pool, affected account and topic    |
| HCS submission confirmed    | The same references and confirmed topic sequence               |
| HCS submission uncertain    | The same references; reconciliation is required                |
| Duplicate or pending report | Whether a prior submission was confirmed or remains unresolved |

The API has no authenticated application session. Request actors are recorded as
`anonymous`; the HCS writer is `hedera-api`. An account in a verified pool event is
the on-chain subject, not proof of who sent the HTTP request. Lending balances,
amounts, private keys, tokens, request bodies, query strings, IP addresses and
free-form error text are not included.

Display text comes from fixed event definitions, for example:
`POST /api/activity returned 403.` and
`HCS submission confirmed at sequence 7.` These are format examples, not historical
records. The export contains only events actually collected.

## Storage and access

Run the collector as a separate operating-system user or on a separate host. Give
the app the collector's ingest token, but no filesystem access to the collector's
ledger and no access to its signing key. Keep both secrets outside the repository.

The collector accepts authenticated `POST /v1/events` requests and acknowledges
them only after the record is written and synced. There is no HTTP endpoint for
reading, changing or deleting records. A read-only command verifies and exports
the ledger for authorized operators. Health checks return no event content.

Each record includes a sequence, collection timestamp, previous-record hash and
HMAC. Duplicate delivery of the same event ID does not add another record. A
conflicting event with the same ID is rejected. Corrupt or incomplete ledger
files prevent startup; they are never silently repaired.

Hash chains detect changes, but someone who controls both the ledger and signing
key can rewrite a chain. Store checkpoints and backups under separate access
controls. For enforced retention, archive to storage with an approved retention
lock. A local file and a hash chain alone do not provide that guarantee.

## Application settings

Set these server-only variables in `packages/nextjs/.env.local` or the app's service
environment. Never use a `NEXT_PUBLIC_` prefix.

| Variable                | Purpose                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `AUDIT_MODE`            | `required` enables durable recording. `off` is the default for an unconfigured scaffold.    |
| `AUDIT_COLLECTOR_URL`   | Fixed collector URL ending in `/v1/events`. Use HTTPS; HTTP is allowed only on loopback.    |
| `AUDIT_COLLECTOR_TOKEN` | Random ingest secret, at least 32 characters.                                               |
| `AUDIT_OUTBOX_DIR`      | Absolute path to a private, persistent directory outside the checkout and activity journal. |

Use a separate outbox for each app process. The outbox is a delivery queue, not
the retained audit ledger. Do not use ephemeral serverless storage. Keep its
directory readable only by the app user and the delivery service running as that
user. Do not place it in a web root or mount it as static content.

When recording is required, requests stop before running their handler if the
initial event cannot be durably queued. HCS submission also requires a recorded
intent before sending. If that write fails after the existing HCS reservation,
the report remains pending and needs reconciliation; no payment is sent.

Admission reserves space for up to four records per request, including the HCS
intent and result. The default outbox limit is 10,000 records; set
`AUDIT_OUTBOX_MAX_RECORDS` to change it. `AUDIT_FLUSH_BATCH_SIZE` limits each replay
run to at most 100 records. Reserved capacity is coordinated within one app
process, which is why each process needs its own outbox.

Collector outages leave events in the outbox for replay. A failed final audit
write does not turn a confirmed HCS operation into a failed payment or trigger a
second submission. It emits `audit.outcome_write_failed` to the service error log
with the request ID. Investigate that alert and any unmatched start event.

## Collector settings

Use a separate environment file for the collector. It must not contain the app's
Hedera private key or Pyth credentials.

| Variable                | Purpose                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `AUDIT_LOG_DIR`         | Absolute path to the collector's private, persistent ledger directory.                                   |
| `AUDIT_COLLECTOR_TOKEN` | Same ingest secret configured on the app.                                                                |
| `AUDIT_SIGNING_KEY`     | Separate random secret, at least 32 characters; available only to the collector and authorized verifier. |
| `AUDIT_COLLECTOR_HOST`  | Defaults to `127.0.0.1`.                                                                                 |
| `AUDIT_COLLECTOR_PORT`  | Collector listen port; defaults to `4318`.                                                               |

Place remote collectors behind an HTTPS reverse proxy with body-size, connection
and rate limits. Restrict network access to app hosts where possible. The ingest
token permits appending valid records; it does not make a compromised app's future
reports trustworthy. Retain independent infrastructure and chain evidence.

## Operation

Run the collector with its environment loaded:

```sh
npm run audit:collector
```

Run delivery with the app's audit-only environment loaded:

```sh
npm run audit:deliver -- --once
```

The delivery command reports pending and delivered counts and exits nonzero while
a backlog remains. Environment files are not automatically loaded by these Node
commands. Use the service manager or a secret manager to supply them.

For a consistent export, stop the writer or work from a complete, protected
snapshot of its journal. With the collector signing key and log directory loaded:

```sh
npm run audit:verify
npm run --silent audit:export -- --format csv > /private/export/hedera.audit.csv
npm run --silent audit:checkpoint > /private/export/hedera.audit.checkpoint.json
npm run audit:verify -- --checkpoint /private/export/hedera.audit.checkpoint.json
```

Use a private export directory and `umask 077`. Keep the checkpoint independently
of the ledger. An older checkpoint establishes that the retained prefix is still
present; it cannot prove that records after that checkpoint were never removed.
Without an independent checkpoint, a cleanly removed tail cannot be distinguished
from a shorter valid ledger. The collector verifies signatures on startup; the
operator's checkpoint check is a separate step.

The templates in `ops/audit/` run the collector as `hedera-audit` and delivery as
`hedera-app`. Before installation, create those users, install Node 22.14+ or 24
and the locked dependencies under `/opt/hedera-lending-market`, and provision:

- `/etc/hedera-audit/collector.env`, owned by root with mode `0600`.
- `/etc/hedera-audit/writer.env`, owned by root with mode `0600`, with audit variables only.
- `/var/lib/hedera-audit-outbox`, owned by `hedera-app` with mode `0700`.

Set the collector's `AUDIT_LOG_DIR=/var/lib/hedera-audit` and the app's
`AUDIT_OUTBOX_DIR=/var/lib/hedera-audit-outbox`. Configure the Next.js service with
the same writer environment. Keep the app user out of the collector's group.
The templates are provided for deployment; they are not installed automatically.

Schedule the outbox delivery command independently of web traffic. Monitor its
exit status, pending count and oldest pending event age. Alert on increasing
backlogs, repeated delivery errors, disk pressure, collector health failures,
missing completion events and failed integrity checks. Do not delete a backlog
to clear an alert.

Files named `.pending-<event-id>` are interrupted local writes and count toward
queue capacity. Preserve and inspect them during recovery; they have not been
acknowledged as accepted events. Do not rename or discard them without checking
the corresponding request and HCS journal. Ledger sequence reflects collection
order; use the event timestamp and request ID to correlate delayed deliveries.

The ledger uses one writer process. After an unclean shutdown, confirm that no
writer is running before removing a stale writer lock. Preserve the ledger and
verify it before resuming. Do not change the signing key on an existing ledger;
plan a new ledger and retain the previous key for verification.

No records are automatically deleted. Before enabling production collection,
assign an owner and document the retention period, archive destination, access
review schedule, incident process and disposal procedure. Verify backup retrieval
and keep an independently protected checkpoint. Avoid filling the collector disk
by monitoring usage and provisioning archive capacity.

## Coverage limits

This collector covers the two instrumented API routes. It is not an autonomous
indexer of every lending transaction. Direct wallet transactions, RPC failures,
static-page visits, GitHub administration, deployments, operator commands and
hosting-provider access need their own evidence sources. The static product
walkthrough at `/Hedera/` does not run these API handlers.

Successful HTTP requests do not establish successful loans. HCS confirmations
refer only to the optional activity mirror. On-chain receipts remain the source
of truth for lending transactions.

## Control mapping

The design supports monitoring and event evaluation under AICPA Trust Services
Criteria CC7.2 and CC7.3, with restricted access supporting CC6.1. It does not
establish SOC 2 compliance by itself. The system scope, operating evidence and
control effectiveness must also be assessed.

SOC 2 does not prescribe a separate database or one universal retention period.
NIST AU-9(2) describes separate audit storage as a protection measure; AU-11 uses
an organization-defined retention period. Set that period from the organization's
commitments and requirements rather than treating an example as a mandate.

- [AICPA Trust Services Criteria](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022)
- [NIST SP 800-53 controls](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
