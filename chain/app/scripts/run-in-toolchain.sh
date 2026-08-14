#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

repo_root="$(git rev-parse --show-toplevel)"
image="golang:1.25.9-alpine3.23@sha256:5caaf1cca9dc351e13deafbc3879fd4754801acba8653fa9540cea125d01a71f"

exec docker run --rm \
  -v "$repo_root:/workspace" \
  -v "$repo_root:$repo_root" \
  -v torium-go-mod-cache:/go/pkg/mod \
  -v torium-go-build-cache:/root/.cache/go-build \
  -w /workspace/chain/app \
  "$image" \
  sh -c 'apk add --no-cache build-base git linux-headers >/dev/null && exec "$@"' sh "$@"
