#!/bin/sh
# Superbot installer for the DeepSeek Harness desktop app (macOS).
# Self-contained: downloads the release tarball, verifies its checksum, installs
# it into the desktop profile via the app's bundled CLI. No repo checkout needed.
set -eu

VERSION="${SUPERBOT_VERSION:-1.4.0}"
BASE="https://github.com/qiuzhiaho1149-prog/superbot/releases/download/v${VERSION}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

case "${1:-}" in
  -h|--help)
    cat <<'TXT'
Usage: sh install-desktop.sh [--uninstall]
  Installs Superbot v1.3.0 into the DeepSeek Harness desktop profile.
  Set DSH_HOME to override ~/.dsh (advanced).
  Set SUPERBOT_VERSION to override the release version.
  --uninstall removes the plugin (ledger/handoffs are kept).
TXT
    exit 0
    ;;
  --uninstall)
    UNINSTALL=1
    ;;
  "") UNINSTALL=0 ;;
  *) fail "unknown argument: $1" ;;
esac

# 1. Locate the desktop app and its bundled CLI.
APP=""
for candidate in "/Applications/DeepSeek Harness.app" "$HOME/Applications/DeepSeek Harness.app"; do
  if [ -x "$candidate/Contents/Resources/runtime/cli/bin/dsh" ]; then APP="$candidate"; break; fi
done
[ -n "$APP" ] || fail "DeepSeek Harness desktop app not found in /Applications (macOS only for now)"
CLI="$APP/Contents/Resources/runtime/cli/bin/dsh"
APP_VERSION="$("$CLI" --version 2>/dev/null | head -1 | tr -d '[:space:]')" || fail "the app's bundled CLI is not runnable: $CLI"
case "$APP_VERSION" in
  0.2.*) : ;;
  *) fail "unsupported DeepSeek Harness version: ${APP_VERSION:-unknown} (Superbot supports 0.2.1-rc.5 through 0.2.x; update the desktop app)" ;;
esac

# 2. Quit check (the app must not rewrite the profile while we install).
if pgrep -f "$APP/Contents/MacOS/DeepSeek Harness" >/dev/null 2>&1 && [ "${SUPERBOT_ALLOW_RUNNING:-0}" != "1" ]; then
  fail "Quit DeepSeek Harness completely (Cmd+Q), then run this again."
fi

# 3. Profile must exist (opening the app once creates it).
[ -f "$PROFILE_DIR/package.json" ] || fail "desktop profile not found: $PROFILE_DIR — open DeepSeek Harness once, quit it, then rerun."

if [ "${UNINSTALL:-0}" = "1" ]; then
  info "Removing Superbot from the desktop profile (ledger and handoffs are kept)..."
  NODE_BIN="$APP/Contents/MacOS/DeepSeek Harness"
  PROFILE_FILE="$PROFILE_DIR/package.json" MODE=uninstall \
  ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" -e '
    const fs = require("fs")
    const file = process.env.PROFILE_FILE
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    if (pkg.dependencies) delete pkg.dependencies["dsh-superbot"]
    if (pkg.dsh?.profile?.bundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== "dsh-superbot")
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
  '
  rm -rf "$PROFILE_DIR/node_modules/dsh-superbot"
  info "Removed. Reopen DeepSeek Harness; superbot storage remains at $DSH_HOME/storages/dsh-superbot."
  exit 0
fi

# 4. Download to a STABLE location (the profile records a file: dependency,
#    so the tarball must outlive this script) and verify the checksum.
INSTALL_DIR="$DSH_HOME/storages/dsh-superbot/install"
mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/superbot-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
TGZ="$INSTALL_DIR/dsh-superbot-${VERSION}.tgz"
info "Downloading Superbot v${VERSION}..."
curl -fL --retry 2 -o "$TGZ.part" "$BASE/dsh-superbot-${VERSION}.tgz" || fail "download failed: $BASE/dsh-superbot-${VERSION}.tgz"
curl -fL --retry 2 -o "$TGZ.SHA256SUMS" "$BASE/SHA256SUMS" || fail "checksum download failed"
mv "$TGZ.part" "$TGZ"
( cd "$INSTALL_DIR" && cp "$TGZ.SHA256SUMS" SHA256SUMS && if command -v shasum >/dev/null 2>&1; then shasum -a 256 -c SHA256SUMS; else sha256sum -c SHA256SUMS; fi ) >/dev/null || { rm -f "$TGZ"; fail "checksum mismatch"; }

# 5. Install WITHOUT running the profile package manager.
#    The tarball has zero npm dependencies (task-engine is vendored); running
#    pnpm/pnpm-add would re-resolve the user's OTHER dependencies and can fail
#    offline or prune packages -> the reported "missing dependency" installs.
STAMP="$(date +%Y%m%d%H%M%S)"
cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak.$STAMP"
[ -f "$PROFILE_DIR/pnpm-lock.yaml" ] && cp "$PROFILE_DIR/pnpm-lock.yaml" "$PROFILE_DIR/pnpm-lock.yaml.bak.$STAMP" || true

NODE_BIN="$APP/Contents/MacOS/DeepSeek Harness"
[ -x "$NODE_BIN" ] || fail "desktop runtime not found: $NODE_BIN"
edit_profile() {
  PROFILE_FILE="$PROFILE_DIR/package.json" TGZ_PATH="$TGZ" MODE="$1" \
  ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" -e '
    const fs = require("fs")
    const file = process.env.PROFILE_FILE
    const tgz = process.env.TGZ_PATH
    const mode = process.env.MODE
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    pkg.dependencies ??= {}
    pkg.dsh ??= {}
    pkg.dsh.profile ??= {}
    pkg.dsh.profile.bundles ??= []
    if (mode === "install") {
      pkg.dependencies["dsh-superbot"] = "file:" + tgz
      if (!pkg.dsh.profile.bundles.includes("dsh-superbot")) pkg.dsh.profile.bundles.push("dsh-superbot")
    } else {
      delete pkg.dependencies["dsh-superbot"]
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== "dsh-superbot")
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
  ' || fail "could not update profile package.json"
}

info "Installing into desktop profile (no package-manager resolution)..."
rm -rf "$PROFILE_DIR/node_modules/dsh-superbot"
mkdir -p "$PROFILE_DIR/node_modules/dsh-superbot"
tar -xzf "$TGZ" -C "$PROFILE_DIR/node_modules/dsh-superbot" --strip-components=1 || fail "could not extract the plugin tarball"
edit_profile install
grep -q '"dsh-superbot"' "$PROFILE_DIR/package.json" || fail "dsh-superbot is missing from profile dependencies"
grep -q 'dsh-superbot' "$PROFILE_DIR/package.json" || fail "dsh-superbot is missing from profile bundles"
info ""
info "Installed Superbot v${VERSION} (self-contained; no npm dependencies)."
info "Reopen DeepSeek Harness → sidebar “Superbot” → 首次接入盘点."
info "Tarball kept at: $TGZ (do not delete it; the profile references it)"
info "Rollback: restore $PROFILE_DIR/package.json.bak.$STAMP and run: sh $0 --uninstall"
