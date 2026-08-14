#!/bin/sh
set -eu

contracts_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$contracts_dir/.." && pwd)
toolchain="$repo_root/chain/toolchain.json"
work_dir="$contracts_dir/.work"
output_dir="$contracts_dir/.artifacts/audit"
metadata_dir="$work_dir/audit-git-$$"

case "$#:${1:-}" in
	0:) ;;
	1:--check) ;;
	*)
		echo "usage: $0 [--check]" >&2
		exit 2
		;;
esac

image=$(node -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(config.runtimes.node.image);
' "$toolchain")

case "$image" in
	*@sha256:????????????????????????????????????????????????????????????????) ;;
	*)
		echo "Node image is not digest-pinned: $image" >&2
		exit 1
		;;
esac

mkdir -p "$metadata_dir" "$output_dir"
cleanup() {
	rm -rf "$metadata_dir"
}
trap cleanup EXIT HUP INT TERM

git -C "$repo_root" rev-parse HEAD >"$metadata_dir/source-commit"
git -C "$repo_root" rev-parse 'HEAD^{tree}' >"$metadata_dir/source-tree"
git -C "$repo_root" ls-tree -r --name-only HEAD >"$metadata_dir/tracked-paths"
git -C "$repo_root" diff --name-only HEAD >"$metadata_dir/changed-paths"

source_commit=$(sed -n '1p' "$metadata_dir/source-commit")
source_tree=$(sed -n '1p' "$metadata_dir/source-tree")
container_metadata="/workspace/contracts/.work/$(basename "$metadata_dir")"

docker run --rm --network none --read-only \
	--user "$(id -u):$(id -g)" \
	-e HOME=/tmp \
	-e NODE_ENV=test \
	-e TORIUM_OFFLINE_TEST=1 \
	-e TORIUM_AUDIT_SOURCE_COMMIT="$source_commit" \
	-e TORIUM_AUDIT_SOURCE_TREE="$source_tree" \
	-e TORIUM_AUDIT_TRACKED_PATHS_FILE="$container_metadata/tracked-paths" \
	-e TORIUM_AUDIT_CHANGED_PATHS_FILE="$container_metadata/changed-paths" \
	--tmpfs /tmp:rw,nosuid,nodev,size=64m \
	-v "$repo_root:/workspace:ro" \
	-v "$work_dir:/workspace/contracts/.work:rw" \
	-v "$output_dir:/workspace/contracts/.artifacts/audit:rw" \
	-w /workspace/contracts \
	--entrypoint node \
	"$image" \
	scripts/generate-audit-bundle.mjs "$@"
