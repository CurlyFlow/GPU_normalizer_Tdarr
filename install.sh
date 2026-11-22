#!/usr/bin/env bash
set -euo pipefail

REPO="CurlyFlow/GPU_normalizer_Tdarr"
VERSION=""
CHANNEL=""
PLUGINS_DIR=""

usage() {
  cat <<'EOF'
Install or update GPU Normalize Audio into Tdarr's LocalFlowPlugins directory.

Usage:
  install.sh [--version <ver>] [--channel latest] <tdarr-plugins-dir>

Examples:
  # Install or update to the latest GitHub release (versioned folder):
  install.sh /path/to/tdarr/server/Tdarr/Plugins

  # Install or update into a stable "latest" folder (existing Flows auto-update):
  install.sh --channel latest /path/to/tdarr/server/Tdarr/Plugins

  # Install a specific release version:
  install.sh --version 1.2.9 /path/to/tdarr/server/Tdarr/Plugins
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "ERR: --version requires an argument" >&2; exit 2; }
      VERSION="${2#v}"
      shift 2
      ;;
    --channel)
      [[ $# -ge 2 ]] || { echo "ERR: --channel requires an argument" >&2; exit 2; }
      CHANNEL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERR: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [[ -z "$PLUGINS_DIR" ]] || { echo "ERR: unexpected extra argument: $1" >&2; exit 2; }
      PLUGINS_DIR="$1"
      shift
      ;;
  esac
done

if [[ -z "$PLUGINS_DIR" ]]; then
  usage >&2
  exit 2
fi

if [[ -n "$CHANNEL" && "$CHANNEL" != "latest" ]]; then
  echo "ERR: unsupported --channel '$CHANNEL' (expected 'latest')" >&2
  exit 2
fi

for cmd in curl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERR: required command not found: $cmd" >&2; exit 1; }
done

if [[ ! -d "$PLUGINS_DIR" ]]; then
  echo "ERR: Tdarr plugins directory does not exist: $PLUGINS_DIR" >&2
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))'
  )"
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "ERR: invalid release version resolved: $VERSION" >&2
  exit 1
fi

ASSET="GPU_normalize_audio_tdarr-${VERSION}.zip"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"
TARGET_SUBDIR="${CHANNEL:-$VERSION}"
DEST_ROOT="${PLUGINS_DIR%/}/FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio"
DEST_DIR="${DEST_ROOT}/${TARGET_SUBDIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${ASSET} (v${VERSION})..."
curl -fsSL "$URL" -o "${TMP_DIR}/${ASSET}"

python3 - "${TMP_DIR}/${ASSET}" "${TMP_DIR}/extract" <<'PY'
import pathlib
import sys
import zipfile

zip_path = pathlib.Path(sys.argv[1])
out_dir = pathlib.Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(zip_path) as archive:
    for info in archive.infolist():
        if info.filename.startswith("/") or ".." in pathlib.Path(info.filename).parts:
            raise SystemExit(f"ERR: unsafe archive path: {info.filename}")
    archive.extractall(out_dir)
PY

SRC_DIR=""
for candidate in \
  "${TMP_DIR}/extract/GPU_normalize_audio_tdarr-${VERSION}/FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio/${VERSION}" \
  "${TMP_DIR}/extract/GPU_normalize_audio_tdarr-${VERSION}/FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/${VERSION}" \
  "${TMP_DIR}/extract/FlowPlugins/LocalFlowPlugins/audio/gpuNormalizeAudio/${VERSION}" \
  "${TMP_DIR}/extract/FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/${VERSION}"; do
  if [[ -f "${candidate}/index.js" ]]; then
    SRC_DIR="$candidate"
    break
  fi
done

if [[ -z "$SRC_DIR" ]]; then
  echo "ERR: could not locate gpuNormalizeAudio/${VERSION}/index.js inside ${ASSET}" >&2
  exit 1
fi

mkdir -p "$DEST_ROOT"
STAGE_DIR="${DEST_ROOT}/.${TARGET_SUBDIR}.staging.$$"
rm -rf "$STAGE_DIR"
cp -a "$SRC_DIR" "$STAGE_DIR"

for bin in \
  "${STAGE_DIR}/runtime/bin/opx_loudnorm_channel_stats.so" \
  "${STAGE_DIR}/runtime/bin/audio_clock_mux" \
  "${STAGE_DIR}/runtime/bin/aac_encode_mt"; do
  [[ -f "$bin" ]] && chmod 755 "$bin"
done

rm -rf "$DEST_DIR"
mv "$STAGE_DIR" "$DEST_DIR"

echo "Installed GPU Normalize Audio v${VERSION} -> ${DEST_DIR}"
echo "Next step: in Tdarr WebUI click 'Sync Plugins' (or restart Tdarr Server/Node), then select 'GPU Normalize Audio' under Local Flow Plugins."
