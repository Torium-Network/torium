#!/bin/sh
set -eu

./scripts/check-go-version.sh

unformatted="$(gofmt -l .)"
if [ -n "$unformatted" ]; then
  echo "Go files require gofmt:" >&2
  echo "$unformatted" >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
binary="$temp_dir/toriumd"
cp go.mod "$temp_dir/go.mod"
cp go.sum "$temp_dir/go.sum"
cleanup() {
  cp "$temp_dir/go.mod" go.mod
  cp "$temp_dir/go.sum" go.sum
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

go mod tidy
if ! cmp -s go.mod "$temp_dir/go.mod" || ! cmp -s go.sum "$temp_dir/go.sum"; then
  echo "go.mod or go.sum is not tidy" >&2
  exit 1
fi

go generate ./...
go test -count=1 ./...
go vet ./...
go run ./cmd/torium-genesis --output-dir ../genesis/localnet --check

CGO_ENABLED=1 go build \
  -trimpath \
  -buildvcs=false \
  -ldflags '-s -w -X github.com/torium-network/torium-chain/internal/version.Version=0.1.0-local.1 -X github.com/torium-network/torium-chain/internal/version.Commit=check -X github.com/torium-network/torium-chain/internal/version.BuildTime=unknown -X github.com/torium-network/torium-chain/internal/version.UpgradeProfile=pre' \
  -o "$binary" ./cmd/toriumd

CGO_ENABLED=1 go build \
  -trimpath \
  -buildvcs=false \
  -o "$temp_dir/torium-genesis" ./cmd/torium-genesis

CGO_ENABLED=1 go build \
  -trimpath \
  -buildvcs=false \
  -o "$temp_dir/torium-localnet" ./cmd/torium-localnet

CGO_ENABLED=1 go build \
  -trimpath \
  -buildvcs=false \
  -ldflags '-s -w -X github.com/torium-network/torium-chain/internal/version.Version=0.1.0-local.1 -X github.com/torium-network/torium-chain/internal/version.Commit=check -X github.com/torium-network/torium-chain/internal/version.BuildTime=unknown -X github.com/torium-network/torium-chain/internal/version.UpgradeProfile=pre' \
  -o "$temp_dir/torium-localnet-state" ./cmd/torium-localnet-state

CGO_ENABLED=1 go build \
  -trimpath \
  -buildvcs=false \
  -ldflags '-s -w' \
  -o "$temp_dir/torium-faucet" ./cmd/torium-faucet

"$binary" genesis validate-genesis ../genesis/localnet/genesis.json >/dev/null
(cd ../genesis/localnet && grep -v '^#' SHA256SUMS | sha256sum -c - >/dev/null)

version_output="$($binary version)"
for required_value in \
  '"name": "Torium"' \
  '"binary": "toriumd"' \
  '"upgradeProfile": "pre"' \
  '"protocolVersion": "1.0.0-local.5"' \
  '"version": "v0.7.0"' \
  '"version": "v0.54.3"' \
  '"version": "v0.39.3"'
do
  if ! echo "$version_output" | grep -F "$required_value" >/dev/null; then
    echo "version output is missing $required_value" >&2
    exit 1
  fi
done
