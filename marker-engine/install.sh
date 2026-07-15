#!/usr/bin/env sh
# Installs this signed Linux engine bundle for the current user only.
set -eu
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/haven-engine"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 is required. Install it, then run this installer again." >&2
  exit 1
fi
if ! command -v secret-tool >/dev/null 2>&1; then
  echo "Secure Linux key storage requires libsecret-tools (secret-tool)." >&2
  echo "Install it through your distribution, sign in to your desktop session, then try again." >&2
  exit 1
fi

mkdir -p "$TARGET" "$BIN_DIR"
mkdir -p "$TARGET/marker-engine" "$TARGET/strategy-sdk"
# Merge updates so an existing non-secret .env is preserved. Credentials live
# in the keyring and are never part of the downloaded bundle.
cp -R "$SOURCE/marker-engine/." "$TARGET/marker-engine"
cp -R "$SOURCE/strategy-sdk/." "$TARGET/strategy-sdk"
chmod 700 "$TARGET/marker-engine/setup.sh" "$TARGET/marker-engine/run.sh"
(cd "$TARGET/marker-engine" && npm ci --omit=dev --no-audit --no-fund)
cat > "$BIN_DIR/haven-engine" <<EOF
#!/usr/bin/env sh
exec "$TARGET/marker-engine/run.sh" "\$@"
EOF
chmod 700 "$BIN_DIR/haven-engine"
echo "Haven Engine installed for this user. Run: haven-engine"
echo "If that command is not found, add $BIN_DIR to your PATH or run $TARGET/marker-engine/run.sh"
