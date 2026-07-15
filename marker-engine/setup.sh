#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 is required. Install it, then run this setup again." >&2
  exit 1
fi
if ! command -v secret-tool >/dev/null 2>&1; then
  echo "Secure Linux key storage requires libsecret-tools (secret-tool)." >&2
  echo "Install it through your distribution, sign in to your desktop session, then try again." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing Haven Engine components (first run only)..."
  npm ci --omit=dev --no-audit --no-fund
fi
exec node setup.js
