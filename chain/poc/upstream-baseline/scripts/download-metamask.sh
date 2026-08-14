#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${TORIUM_POC_WORK_DIR:-${POC_DIR}/.work}"
VERSION="13.39.2"
ARCHIVE="${WORK_DIR}/metamask-chrome-${VERSION}.zip"
DESTINATION="${WORK_DIR}/metamask-chrome-${VERSION}"
EXPECTED_SHA256="34212dfb1f8a416cb00dd090caa391070c77e3f54299fbec65a2dbcca2fadeac"
URL="https://github.com/MetaMask/metamask-extension/releases/download/v${VERSION}/metamask-chrome-${VERSION}.zip"

for command in curl unzip; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done

mkdir -p "${WORK_DIR}"
curl --fail --location --retry 3 --output "${ARCHIVE}" "${URL}"

if command -v sha256sum >/dev/null; then
  actual_sha256="$(sha256sum "${ARCHIVE}" | awk '{ print $1 }')"
else
  actual_sha256="$(shasum -a 256 "${ARCHIVE}" | awk '{ print $1 }')"
fi

if [[ "${actual_sha256}" != "${EXPECTED_SHA256}" ]]; then
  echo "MetaMask archive checksum mismatch: ${actual_sha256}" >&2
  exit 1
fi

rm -rf "${DESTINATION}"
mkdir -p "${DESTINATION}"
unzip -q "${ARCHIVE}" -d "${DESTINATION}"
echo "Verified MetaMask ${VERSION}: ${DESTINATION}"
