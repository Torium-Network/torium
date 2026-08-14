#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${TORIUM_POC_WORK_DIR:-${POC_DIR}/.work}"
UPSTREAM_DIR="${WORK_DIR}/cosmos-evm"

if [[ -f "${UPSTREAM_DIR}/docker-compose.yml" ]]; then
  docker compose \
    --project-name torium-cosmos-evm-baseline \
    --file "${UPSTREAM_DIR}/docker-compose.yml" \
    down --remove-orphans
else
  docker rm --force evmdnode0 evmdnode1 evmdnode2 evmdnode3 >/dev/null 2>&1 || true
fi
