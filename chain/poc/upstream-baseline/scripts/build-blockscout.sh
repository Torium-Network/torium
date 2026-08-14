#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${TORIUM_POC_WORK_DIR:-${POC_DIR}/.work}"
SOURCE_DIR="${WORK_DIR}/blockscout"
REPOSITORY="https://github.com/blockscout/blockscout.git"
TAG="v11.2.2"
COMMIT="731015d88d7e73623f2a3c097e241bc82b04ea7a"
IMAGE="torium/blockscout-poc:v11.2.2"

mkdir -p "${WORK_DIR}"
if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  git clone --filter=blob:none "${REPOSITORY}" "${SOURCE_DIR}"
fi
git -C "${SOURCE_DIR}" fetch --force origin "refs/tags/${TAG}:refs/tags/${TAG}"
git -C "${SOURCE_DIR}" checkout --detach "${COMMIT}"

actual_commit="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${COMMIT}" ]]; then
  echo "Blockscout commit mismatch: ${actual_commit}" >&2
  exit 1
fi

docker build \
  --file "${SOURCE_DIR}/docker/Dockerfile" \
  --build-arg RELEASE_VERSION=11.2.2 \
  --build-arg BLOCKSCOUT_VERSION=v11.2.2 \
  --tag "${IMAGE}" \
  "${SOURCE_DIR}"

echo "Built ${IMAGE} from ${COMMIT}"
