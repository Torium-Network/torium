#!/bin/sh
set -eu

contract_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$contract_dir/.." && pwd)
image=$(node -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(config.runtimes.node.image);
' "$repo_root/chain/toolchain.json")

mkdir -p "$contract_dir/.work"

exec docker run --rm --network none --read-only \
	--user "$(id -u):$(id -g)" \
	-e HOME=/tmp \
	-e NODE_ENV=test \
	-e TORIUM_OFFLINE_TEST=1 \
	--tmpfs /tmp:rw,nosuid,nodev,size=64m \
	-v "$repo_root:/workspace:ro" \
	-v "$contract_dir/.work:/workspace/contracts/.work:rw" \
	-w /workspace/contracts \
	--entrypoint sh \
	"$image" \
	-c 'exec "$@"' sh "$@"
