#!/usr/bin/env bash

set -euo pipefail

REPO="${OPEN_SESSION_REPO:-josiahwiebe/opensession}"
BIN_NAME="opensession"
ALIAS_NAME="ops"
INSTALL_DIR="${OPEN_SESSION_INSTALL_DIR:-${HOME}/.local/bin}"

usage() {
  cat <<EOF
Install ${BIN_NAME} from GitHub Releases

Usage:
  ./install.sh [version]

Examples:
  ./install.sh              # latest release
  ./install.sh v0.1.0       # explicit tag

Environment overrides:
  OPEN_SESSION_MGR_REPO=owner/repo
  OPEN_SESSION_MGR_INSTALL_DIR=/custom/bin
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${OS}" in
darwin) platform="darwin" ;;
linux) platform="linux" ;;
*)
  echo "Unsupported OS: ${OS}"
  exit 1
  ;;
esac

case "${ARCH}" in
arm64|aarch64) target_arch="arm64" ;;
x86_64|amd64) target_arch="x64" ;;
*)
  echo "Unsupported architecture: ${ARCH}"
  exit 1
  ;;
esac

requested_version="${1:-}"
if [[ -z "${requested_version}" ]]; then
  requested_version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi

if [[ -z "${requested_version}" ]]; then
  echo "Could not determine release version"
  exit 1
fi

if [[ "${requested_version}" != v* ]]; then
  requested_version="v${requested_version}"
fi

version_no_v="${requested_version#v}"
asset_name="${BIN_NAME}-v${version_no_v}-${platform}-${target_arch}.tar.gz"
asset_url="https://github.com/${REPO}/releases/download/${requested_version}/${asset_name}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

echo "Downloading ${asset_name}"
curl -fL "${asset_url}" -o "${tmp_dir}/${asset_name}"

tar -xzf "${tmp_dir}/${asset_name}" -C "${tmp_dir}"
mkdir -p "${INSTALL_DIR}"
install -m 0755 "${tmp_dir}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"
ln -sf "${INSTALL_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${ALIAS_NAME}"

echo "Installed ${BIN_NAME} to ${INSTALL_DIR}/${BIN_NAME}"
echo "Alias created: ${INSTALL_DIR}/${ALIAS_NAME}"
echo "Run: ${BIN_NAME} --version"
echo "Or: ${ALIAS_NAME} --version"
