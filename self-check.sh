#!/usr/bin/env bash
# Local checks only. Public scaffolding, browser/wallet execution and chain evidence
# are separate acceptance checks; a skipped local check is never counted as passed.
set -euo pipefail
cd "$(dirname "$0")"
fail=0
app_mode=0
if [ "${1:-}" = "--app" ]; then
  app_mode=1
elif [ "$#" -ne 0 ]; then
  printf 'Usage: ./self-check.sh [--app]\n' >&2
  exit 2
fi
ok() { printf '  PASS %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }
run_check() {
  local label="$1"
  shift
  local logfile
  logfile=$(mktemp)
  if "$@" >"$logfile" 2>&1; then ok "$label"; else bad "$label"; cat "$logfile"; fi
  rm -f "$logfile"
}

if [ "$app_mode" -eq 1 ]; then
  printf 'App validation (source template manifest validation explicitly excluded)\n'
else
  printf 'Template source validation (manifest required)\n'
  if [ -f template.json ]; then ok 'template.json present'; else bad 'template.json missing'; fi
fi
for file in README.md AGENTS.md LICENSE package-lock.json packages/hardhat/package.json packages/nextjs/package.json; do
  if [ -f "$file" ]; then ok "$file present"; else bad "$file missing"; fi
done
run_check 'declared root commands and selected validation scope' node -e '
const p = require("./package.json");
if (process.argv[1] !== "1") {
  const m = require("./template.json"), b = m["create-scaffold-hbar"];
  if (!m.name || !b || !b.outro?.sections?.length || !b.capabilities?.packageManager?.includes("npm")) process.exit(1);
}
for (const key of ["test", "test:app", "test:tooling", "test:fork", "export-abis", "deploy", "bootstrap", "dev", "lint", "build", "check:template", "audit:production"]) {
  if (!p.scripts[key]) throw new Error(`Missing script ${key}`);
}' "$app_mode"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.env\.(example|sample)$' >/dev/null; then
    bad 'tracked environment file; remove secrets from history before publication'
  else ok 'no tracked non-example .env files'; fi
  if git grep -l -iE 'private[_-]?key[[:space:]]*[:=][[:space:]]*["\x27]?(0x)?[0-9a-f]{64}' -- ':!package-lock.json' ':!*.md' ':!*.example' >/dev/null 2>&1; then
    bad 'possible private key literal (review locally; values omitted)'
  else ok 'private-key literal heuristic (not a complete secret scan)'; fi
else bad 'Git metadata missing; cannot check tracked files'; fi

if [ "$fail" -ne 0 ]; then
  printf '\nStatic validation FAILED; toolchain checks were not run.\n'
  exit 1
fi

if [ ! -d node_modules ]; then
  bad 'dependencies missing; run npm ci before checking (toolchain checks not run)'
else
  run_check 'contracts compile' npm run compile
  run_check 'unit and regression tests' npm test
  run_check 'all workspace lint and type checks' npm run lint
  run_check 'production frontend build' npm run build
fi

printf '\nSeparate acceptance checks still required:\n'
printf '  - public GitHub scaffold, fresh install, rendered browser routes and wallet flows\n'
printf '  - testnet deployment and current Hashscan/mirror-node evidence\n'
printf '  - configured Hermes API access and a working liquidation route\n'
printf '  - npm run test:fork (network-dependent mainnet-fork harness and ecosystem checks)\n'
printf '  - bounty eligibility review and dependency/license notices\n'
if [ "$fail" -ne 0 ]; then printf '\nLocal validation FAILED.\n'; exit 1; fi
if [ "$app_mode" -eq 1 ]; then
  printf '\nApp validation passed; source manifest validation was not run.\n'
else
  printf '\nTemplate source validation passed; this is not proof of full bounty eligibility.\n'
fi
