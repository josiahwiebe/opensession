#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
RELEASE_DIR="${DIST_DIR}/release"
BIN_NAME="opensession"

VERSION="${OPEN_SESSION_VERSION:-}"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(bun -e 'import pkg from "./package.json"; console.log(pkg.version)')"
fi

if [[ -z "${VERSION}" ]]; then
  echo "Unable to determine version"
  exit 1
fi

target_override="${OPEN_SESSION_TARGET:-}"
suffix_override="${OPEN_SESSION_SUFFIX:-}"

if [[ -n "${target_override}" && -n "${suffix_override}" ]]; then
  target="${target_override}"
  suffix="${suffix_override}"
else
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "${os}" in
  darwin) platform="darwin" ;;
  linux) platform="linux" ;;
  *)
    echo "Unsupported OS: ${os}"
    exit 1
    ;;
  esac

  case "${arch}" in
  arm64 | aarch64)
    target="bun-${platform}-arm64"
    suffix="${platform}-arm64"
    ;;
  x86_64 | amd64)
    target="bun-${platform}-x64"
    suffix="${platform}-x64"
    ;;
  *)
    echo "Unsupported architecture: ${arch}"
    exit 1
    ;;
  esac
fi

rm -rf "${RELEASE_DIR}"
mkdir -p "${DIST_DIR}" "${RELEASE_DIR}"

echo "Building ${target}"
bun build \
  --compile \
  --format=esm \
  --minify \
  --bytecode \
  --sourcemap=none \
  --target="${target}" \
  --define __APP_VERSION__="\"${VERSION}\"" \
  "${ROOT_DIR}/src/index.ts" \
  --outfile "${DIST_DIR}/${BIN_NAME}"

chmod +x "${DIST_DIR}/${BIN_NAME}"

archive_name="${BIN_NAME}-v${VERSION}-${suffix}.tar.gz"
tar -C "${DIST_DIR}" -czf "${RELEASE_DIR}/${archive_name}" "${BIN_NAME}"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${RELEASE_DIR}" && sha256sum ./*.tar.gz > checksums.txt)
else
  (cd "${RELEASE_DIR}" && shasum -a 256 ./*.tar.gz > checksums.txt)
fi

cp "${ROOT_DIR}/scripts/install.sh" "${RELEASE_DIR}/install.sh"
chmod +x "${RELEASE_DIR}/install.sh"

echo "Release artifacts written to ${RELEASE_DIR}"
