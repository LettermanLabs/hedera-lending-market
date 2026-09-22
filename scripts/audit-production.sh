#!/usr/bin/env bash
# Keep this builtin npm command in a shell file: scaffold-hbar 0.4's text
# conversion otherwise changes `npm audit` into `npm run audit` in JSON/YAML.
set -euo pipefail
cd "$(dirname "$0")/.."
npm audit --omit=dev --audit-level=high
