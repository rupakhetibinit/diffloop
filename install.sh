#!/usr/bin/env sh
set -eu

REPO="rupakhetibinit/diffloop"
DIR="${DIFFLOOP_INSTALL_DIR:-/usr/local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) case "$arch" in arm64|aarch64) asset="diffloop-darwin-arm64" ;; *) asset="diffloop-darwin-x64" ;; esac ;;
  Linux) case "$arch" in arm64|aarch64) asset="diffloop-linux-arm64" ;; *) asset="diffloop-linux-x64" ;; esac ;;
  *) echo "diffloop: unsupported OS $os" >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/$asset"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

echo "Downloading diffloop ($asset)..."
curl -fL "$url" -o "$tmp"
chmod 755 "$tmp"

if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR" 2>/dev/null || sudo mkdir -p "$DIR"
fi
if [ -w "$DIR" ]; then
  mv "$tmp" "$DIR/diffloop"
else
  echo "Elevating to install into $DIR"
  sudo mv "$tmp" "$DIR/diffloop"
fi

echo "Installed: $DIR/diffloop"
echo "Run: diffloop --repo /path/to/repo"
