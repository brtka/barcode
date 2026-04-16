#!/usr/bin/env bash
# Build a TRULY standalone barcode binary (single file, no sibling node_modules).
#
# All JS is bundled by esbuild. The native @serialport/bindings-cpp addon
# (node.napi.node) is embedded as a SEA asset and extracted/dlopen'd at
# runtime by ./shims/node-gyp-build.js.
#
# Usage:
#   ./build.sh win       # build dist/win/barcode.exe
#   ./build.sh mac       # build dist/mac/barcode
#   ./build.sh linux     # build dist/linux/barcode
#
# For Windows target, a prebuilt Windows node.exe is needed. Default:
#   /Users/brle/code/mosy/webpack/scripts/sea/node-win-22.11.0.exe
# Override with:
#   NODE_WIN=/path/to/node.exe ./build.sh win

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Usage: $0 {win|mac|linux}"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist/$TARGET"
BUNDLE="$ROOT/barcode.bundle.js"
BLOB="$ROOT/barcode.blob"
SEA_CFG="$ROOT/barcode.sea-config.json"
PREBUILDS="$ROOT/node_modules/@serialport/bindings-cpp/prebuilds"
MOSY_SEA="/Users/brle/code/mosy/webpack/scripts/sea"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "[ERROR] node_modules missing. Run: npm install"
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$DIST"

# 1. Pick the native addon for the target platform.
case "$TARGET" in
  win)
    NODE_BIN="${NODE_WIN:-$MOSY_SEA/node-win-22.11.0.exe}"
    if [ ! -f "$NODE_BIN" ]; then
      echo "[ERROR] Windows node.exe not found at: $NODE_BIN"
      exit 1
    fi
    EXE="$DIST/barcode.exe"
    NAPI_SRC="$PREBUILDS/win32-x64/node.napi.node"
    POSTJECT_EXTRA=""
    ;;
  mac)
    NODE_BIN="$(command -v node)"
    EXE="$DIST/barcode"
    if [ -f "$PREBUILDS/darwin-x64+arm64/node.napi.node" ]; then
      NAPI_SRC="$PREBUILDS/darwin-x64+arm64/node.napi.node"
    else
      NAPI_SRC="$PREBUILDS/darwin-$(node -p 'process.arch')/node.napi.node"
    fi
    POSTJECT_EXTRA="--macho-segment-name NODE_SEA"
    ;;
  linux)
    NODE_BIN="${NODE_LINUX:-$MOSY_SEA/node-linux-22.11.0}"
    if [ ! -f "$NODE_BIN" ]; then
      echo "[ERROR] Linux node binary not found at: $NODE_BIN"
      exit 1
    fi
    EXE="$DIST/barcode"
    # Default to glibc; override with NAPI_SRC=.../node.napi.musl.node if needed.
    NAPI_SRC="${NAPI_SRC:-$PREBUILDS/linux-x64/node.napi.glibc.node}"
    POSTJECT_EXTRA=""
    ;;
  *)
    echo "Unknown target: $TARGET"; exit 1
    ;;
esac

if [ ! -f "$NAPI_SRC" ]; then
  echo "[ERROR] Native addon not found: $NAPI_SRC"
  exit 1
fi

# 2. Bundle all JS (including serialport, ws, node-gyp-build shim) into one file.
echo "[1/5] Bundling JS with esbuild (node-gyp-build aliased to SEA shim)..."
(cd "$ROOT" && npx esbuild barcode.js \
  --bundle --platform=node --target=node22 \
  --alias:node-gyp-build=./shims/node-gyp-build.js \
  --outfile="barcode.bundle.js" \
  --log-level=warning)

# 3. Write a SEA config that embeds index.html AND the native addon.
echo "[2/5] Writing SEA config (assets: index.html, napi)..."
NAPI_ESCAPED=$(printf '%s' "$NAPI_SRC" | sed 's/\\/\\\\/g; s/"/\\"/g')
cat > "$SEA_CFG" <<EOF
{
  "main": "barcode.bundle.js",
  "output": "barcode.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false,
  "assets": {
    "index.html": "public/index.html",
    "napi": "$NAPI_ESCAPED"
  }
}
EOF

echo "[3/5] Generating SEA blob..."
(cd "$ROOT" && node --experimental-sea-config "$SEA_CFG")

# 4. Copy target node binary and inject the SEA blob.
echo "[4/5] Copying $NODE_BIN -> $EXE and injecting SEA blob..."
cp -f "$NODE_BIN" "$EXE"
chmod +w "$EXE"

if [ "$TARGET" = "mac" ]; then
  codesign --remove-signature "$EXE" 2>/dev/null || true
fi

(cd "$ROOT" && npx -y postject "$EXE" NODE_SEA_BLOB barcode.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  $POSTJECT_EXTRA)

if [ "$TARGET" = "mac" ]; then
  codesign --sign - "$EXE" 2>/dev/null || true
fi

# 5. Clean up intermediates.
echo "[5/5] Cleaning up..."
rm -f "$BLOB" "$BUNDLE" "$SEA_CFG"

SIZE=$(du -sh "$EXE" | cut -f1)
echo
echo "DONE. $EXE ($SIZE) — single file, no node_modules."
ls -la "$DIST"
