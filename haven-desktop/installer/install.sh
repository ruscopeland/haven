#!/bin/bash
# Haven Desktop Installer for Linux
# Installs haven-desktop to /opt/haven with a .desktop entry and symlink.
set -euo pipefail

APP_NAME="haven-desktop"
INSTALL_DIR="/opt/haven"
BIN_DIR="/usr/local/bin"

echo "=== Haven Desktop Installer ==="
echo ""

# Check for existing installation
if [ -d "$INSTALL_DIR" ]; then
    echo "Updating existing installation at $INSTALL_DIR"
    sudo rm -rf "$INSTALL_DIR"
fi

# Create directories
sudo mkdir -p "$INSTALL_DIR"

# Copy binary
if [ -f "./bin/$APP_NAME" ]; then
    sudo cp "./bin/$APP_NAME" "$INSTALL_DIR/$APP_NAME"
    sudo chmod 755 "$INSTALL_DIR/$APP_NAME"
elif [ -f "./$APP_NAME" ]; then
    sudo cp "./$APP_NAME" "$INSTALL_DIR/$APP_NAME"
    sudo chmod 755 "$INSTALL_DIR/$APP_NAME"
else
    echo "ERROR: $APP_NAME binary not found"
    exit 1
fi

# Create symlink
sudo ln -sf "$INSTALL_DIR/$APP_NAME" "$BIN_DIR/haven"

# .desktop entry
sudo bash -c "cat > /usr/share/applications/haven.desktop" << EOF
[Desktop Entry]
Name=Haven
Comment=Crypto Research & Strategy Workspace
Exec=$INSTALL_DIR/$APP_NAME
Icon=$INSTALL_DIR/icon.png
Terminal=false
Type=Application
Categories=Finance;Office;
StartupWMClass=Haven
EOF

echo ""
echo "Haven installed successfully."
echo "Run with: haven"
echo "Or find it in your application menu."
