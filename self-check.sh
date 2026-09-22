#!/usr/bin/env bash
# Eligibility-gate self check for the Hedera Lending Market template.
# Mirrors the Scaffold-HBAR Template Bounty gate items that can be verified locally.
set -euo pipefail

fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗ %s\033[0m\n" "$1"; fail=1; }

echo "== Scaffold-HBAR template self check =="

# 1. Required files
[ -f template.json ]               && ok "template.json present"            || bad "template.json missing"
[ -f README.md ]                   && ok "README.md present"               || bad "README.md missing"
[ -f AGENTS.md ]                   && ok "AGENTS.md present"               || bad "AGENTS.md missing"
[ -f LICENSE ]                     && ok "LICENSE present"                 || bad "LICENSE missing"
[ -d packages/hardhat ]            && ok "packages/hardhat present"        || bad "packages/hardhat missing"
[ -d packages/nextjs ]             && ok "packages/nextjs present"         || bad "packages/nextjs missing"

# 2. template.json is valid JSON with the manifest block
node -e "const m=require('./template.json'); if(!m['create-scaffold-hbar']) process.exit(1)" \
  && ok "template.json valid + has create-scaffold-hbar block" \
  || bad "template.json invalid or missing create-scaffold-hbar block"

# 3. No committed secrets
if git ls-files | grep -qE '(^|/)\.env$|\.env\.local$'; then
  bad "a .env/.env.local file is committed"
else
  ok "no committed .env files"
fi
if git grep -nE 'private[_-]?key\s*=\s*["'"'"']?[0-9a-fA-F]{60,}' -- . ':!*.example' ':!*.md' > /dev/null 2>&1; then
  bad "possible committed private key"
else
  ok "no committed private keys detected"
fi

# 4. Toolchain checks (skip if deps are not installed yet)
if [ -d node_modules ]; then
  npm run compile -w @sh/hardhat --silent > /dev/null 2>&1 \
    && ok "contracts compile" || bad "contracts do not compile"
  npm test -w @sh/hardhat --silent > /dev/null 2>&1 \
    && ok "hardhat tests pass" || bad "hardhat tests failing"
  npm run lint -w @sh/nextjs --silent > /dev/null 2>&1 \
    && ok "frontend lint passes" || bad "frontend lint failing"
  npm run build -w @sh/nextjs --silent > /dev/null 2>&1 \
    && ok "frontend builds" || bad "frontend build failing"
else
  echo "  (node_modules missing — run npm install to enable toolchain checks)"
fi

# 5. Hedera service evidence
grep -q "Pyth" README.md && grep -q "SaucerSwap" README.md && grep -q "HTS" README.md \
  && ok "ecosystem integrations documented" || bad "integrations not documented"

echo
if [ "$fail" -eq 0 ]; then
  echo "All local gate checks passed. Remaining gate items need a testnet deployment:"
  echo "  - npm run deploy && npm run bootstrap"
  echo "  - add Hashscan/mirror-node links to the 'Evidence' section of README.md"
  exit 0
else
  echo "Self check FAILED — fix the items above."
  exit 1
fi
