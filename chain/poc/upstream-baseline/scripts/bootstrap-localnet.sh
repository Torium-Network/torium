#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${TORIUM_POC_WORK_DIR:-${POC_DIR}/.work}"
UPSTREAM_DIR="${WORK_DIR}/cosmos-evm"

COSMOS_EVM_REPOSITORY="https://github.com/cosmos/evm.git"
COSMOS_EVM_TAG="v0.7.0"
COSMOS_EVM_COMMIT="f4ab9a3e3fbe353468327d5cacda94b33b41ed11"
IMAGE="torium/cosmos-evm-poc:v0.7.0"
COMPOSE_PROJECT="torium-cosmos-evm-baseline"
MAX_BLOCK_GAS="${TORIUM_POC_MAX_BLOCK_GAS:--1}"

for command in docker git curl; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done

mkdir -p "${WORK_DIR}"
if [[ ! -d "${UPSTREAM_DIR}/.git" ]]; then
  git clone --filter=blob:none "${COSMOS_EVM_REPOSITORY}" "${UPSTREAM_DIR}"
fi

git -C "${UPSTREAM_DIR}" fetch --force origin "refs/tags/${COSMOS_EVM_TAG}:refs/tags/${COSMOS_EVM_TAG}"
git -C "${UPSTREAM_DIR}" checkout --detach "${COSMOS_EVM_COMMIT}"

actual_commit="$(git -C "${UPSTREAM_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${COSMOS_EVM_COMMIT}" ]]; then
  echo "Cosmos EVM commit mismatch: ${actual_commit}" >&2
  exit 1
fi

rm -rf "${UPSTREAM_DIR}/.testnets"
if [[ -n "$(git -C "${UPSTREAM_DIR}" status --porcelain --untracked-files=no)" ]]; then
  echo "Cosmos EVM source has local modifications; refusing a non-reproducible build" >&2
  echo "Remove ${UPSTREAM_DIR} and rerun to recreate the pinned source" >&2
  exit 1
fi
docker build \
  --file "${POC_DIR}/Dockerfile.cosmos-evm-v0.7.0" \
  --tag "${IMAGE}" \
  "${UPSTREAM_DIR}"
docker tag "${IMAGE}" cosmos/evmd

# These fixed names belong only to the upstream reference compose file.
docker rm --force evmdnode0 evmdnode1 evmdnode2 evmdnode3 >/dev/null 2>&1 || true
# Remove an orphaned network from an earlier run of this Torium PoC. The
# upstream compose fixes the subnet, so a stale differently named project
# network otherwise prevents a reproducible rerun.
while IFS= read -r network; do
  subnet="$(docker network inspect "${network}" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
  project="$(docker network inspect "${network}" --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  if [[ "${subnet}" == "192.168.10.0/25" && "${project}" == torium-cosmos-evm-* ]]; then
    docker network rm "${network}" >/dev/null
  fi
done < <(docker network ls --format '{{.Name}}')

docker run --rm \
  --volume "${UPSTREAM_DIR}/.testnets:/data" \
  "${IMAGE}" \
  testnet init-files \
  --validator-count 4 \
  --output-dir /data \
  --starting-ip-address 192.168.10.2 \
  --keyring-backend test \
  --chain-id local-4221 \
  --use-docker

if [[ "${MAX_BLOCK_GAS}" != "-1" ]]; then
  if [[ ! "${MAX_BLOCK_GAS}" =~ ^[1-9][0-9]*$ ]]; then
    echo "TORIUM_POC_MAX_BLOCK_GAS must be -1 or a positive integer" >&2
    exit 1
  fi
  command -v node >/dev/null || {
    echo "Node.js is required for the bounded block-gas test profile" >&2
    exit 1
  }
  node "${SCRIPT_DIR}/set-max-block-gas.mjs" \
    "${UPSTREAM_DIR}/.testnets" \
    "${MAX_BLOCK_GAS}"
fi

# v0.7.0 generates CometBFT's legacy `flood` mode, but Cosmos EVM's app-side
# mempool rejects that mode at startup. This one-line configuration overlay is
# the only runtime delta in the baseline PoC.
for config in "${UPSTREAM_DIR}"/.testnets/node*/evmd/config/config.toml; do
  if [[ "$(grep -c '^type = "flood"$' "${config}")" != "1" ]]; then
    echo "Expected exactly one flood mempool setting in ${config}" >&2
    exit 1
  fi
  sed 's/^type = "flood"$/type = "app"/' "${config}" >"${config}.tmp"
  mv "${config}.tmp" "${config}"
done

if [[ "$(grep -h -c '^type = "app"$' "${UPSTREAM_DIR}"/.testnets/node*/evmd/config/config.toml | awk '{ total += $1 } END { print total }')" != "4" ]]; then
  echo "Failed to configure the app-side mempool on all validators" >&2
  exit 1
fi

docker compose \
  --project-name "${COMPOSE_PROJECT}" \
  --file "${UPSTREAM_DIR}/docker-compose.yml" \
  up --detach

for attempt in $(seq 1 90); do
  response="$(curl --silent --show-error \
    --header 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    http://127.0.0.1:8545 2>/dev/null || true)"
  if [[ "${response}" == *'"result":"0x'* ]]; then
    echo "Cosmos EVM ${COSMOS_EVM_TAG} localnet is ready at http://127.0.0.1:8545"
    exit 0
  fi
  sleep 1
done

docker compose \
  --project-name "${COMPOSE_PROJECT}" \
  --file "${UPSTREAM_DIR}/docker-compose.yml" \
  logs --tail 200 >&2
echo "Localnet did not become ready within 90 seconds" >&2
exit 1
