#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 is required. Install it, then run setup.sh again." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "No configuration found. Starting one-time setup..."
  exec ./setup.sh
fi
if [ ! -d node_modules ]; then
  echo "Installing Haven Engine components (first run only)..."
  npm ci --omit=dev --no-audit --no-fund
fi
echo "Starting Haven Engine. Leave this terminal open while trading. Press Ctrl+C to stop."
exec node index.js
