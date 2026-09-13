#!/bin/sh
set -e

REPO="kinjo12/crm.cli"
INSTALL_DIR="${CRM_INSTALL_DIR:-$HOME/.local/bin}"

usage() {
  cat <<EOF
crm.cli installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- [OPTIONS]

Options:
  --help      Show this help message
EOF
  exit 0
}

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      ;;
  esac
done

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)
    echo "Error: unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "Detected platform: ${PLATFORM}-${ARCH}"

install_mount_deps() {
  echo ""
  echo "Installing mount dependencies..."
  case "$PLATFORM" in
    linux)
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y libfuse3-dev libsqlite3-dev
      elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y fuse3-devel sqlite-devel
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm fuse3 sqlite
      else
        echo "Warning: could not detect package manager. Install libfuse3-dev and libsqlite3-dev manually."
      fi
      ;;
    darwin)
      if command -v cargo >/dev/null 2>&1; then
        echo "Rust toolchain found."
      else
        echo "Installing Rust toolchain (needed for NFS server on macOS)..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        . "$HOME/.cargo/env"
      fi
      ;;
  esac
}

# Get latest release tag
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$LATEST" ]; then
  echo "Could not find a release for $REPO (this fork does not currently publish"
  echo "precompiled releases; this can also happen if the GitHub API request failed)."
  echo ""
  echo "Build from source instead:"
  echo "  git clone https://github.com/$REPO.git"
  echo "  cd crm.cli"
  echo "  bun install"
  echo "  bun run build"
  echo "  mkdir -p \"$INSTALL_DIR\""
  echo "  ln -sf \"\$(pwd)/dist/cli.js\" \"$INSTALL_DIR/crm\""
  echo "  chmod +x \"$INSTALL_DIR/crm\""
  echo ""
  echo "(NOTE: this does not silently fall back to installing upstream's dzhng/crm.cli binary,"
  echo "which would not include this fork's fixes.)"
  # Install mount deps here too (not just the success path below): they're useful prep
  # for the build-from-source flow above regardless of why the release lookup failed.
  install_mount_deps
  exit 1
fi
echo "Latest release: $LATEST"

# Download binary
BINARY_NAME="crm-${PLATFORM}-${ARCH}"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST/$BINARY_NAME"
echo "Downloading $DOWNLOAD_URL..."

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL -o "$TMP_DIR/crm" "$DOWNLOAD_URL"
chmod +x "$TMP_DIR/crm"

# Install binary
mkdir -p "$INSTALL_DIR"
mv "$TMP_DIR/crm" "$INSTALL_DIR/crm"
echo "Installed crm to $INSTALL_DIR/crm"

# Check if INSTALL_DIR is in PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Warning: $INSTALL_DIR is not in your PATH."
    echo "Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    ;;
esac

install_mount_deps

echo ""
echo "crm.cli installed successfully!"
echo "Run 'crm --help' to get started."
