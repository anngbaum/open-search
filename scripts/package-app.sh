#!/bin/bash
set -euo pipefail

# Package OpenSearch.app for distribution
# Steps: bundle server → build Xcode project → create zip
# Output: dist/OpenSearch.zip

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
XCODE_DIR="$PROJECT_DIR/OpenSearch"
DIST_DIR="$PROJECT_DIR/dist"
BUILD_DIR="$XCODE_DIR/build"

echo "=== Packaging OpenSearch for distribution ==="
echo ""

# --- Step 1: Bundle the Node.js server ---
echo "--- Step 1/3: Bundling server ---"
bash "$SCRIPT_DIR/bundle-server.sh"
echo ""

# --- Step 2: Build the Xcode project (Release) ---
echo "--- Step 2/3: Building Xcode project (Release) ---"
cd "$XCODE_DIR"
xcodebuild -scheme OpenSearch \
  -configuration Release \
  -derivedDataPath build \
  -destination 'platform=macOS' \
  build \
  2>&1 | grep -E '(BUILD|error:|warning:.*Bundle)' || true

APP_PATH="$BUILD_DIR/Build/Products/Release/OpenSearch.app"
if [ ! -d "$APP_PATH" ]; then
  echo "error: Build failed — OpenSearch.app not found"
  exit 1
fi
echo "Build succeeded: $APP_PATH"
echo ""

# --- Step 3: Create distributable zip ---
echo "--- Step 3/3: Creating distributable zip ---"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Use ditto to preserve macOS metadata and code signatures
ditto -c -k --keepParent "$APP_PATH" "$DIST_DIR/OpenSearch.zip"

ZIP_SIZE=$(du -h "$DIST_DIR/OpenSearch.zip" | cut -f1)
echo ""
echo "=== Packaging complete ==="
echo "Output: $DIST_DIR/OpenSearch.zip ($ZIP_SIZE)"
echo ""
echo "To install:"
echo "  1. Unzip OpenSearch.zip"
echo "  2. Move OpenSearch.app to /Applications"
echo "  3. Grant Full Disk Access: System Settings → Privacy & Security → Full Disk Access → add OpenSearch"
echo "  4. Launch OpenSearch"
