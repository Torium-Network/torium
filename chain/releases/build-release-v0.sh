#!/bin/sh
# Torium reproducible release builder (#122). Produces bit-reproducible chain
# binaries, deterministic archives, an OCI container image, SHA256SUMS, an
# SPDX SBOM, and SLSA provenance — all from the digest-pinned toolchain in
# chain/toolchain.json. It NEVER publishes anything; output stays in an
# untracked local directory. Production signing keys are user-owned; the
# optional signing step accepts a key file or generates a clearly-valueless
# throwaway rehearsal key.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
toolchain="$repo_root/chain/toolchain.json"
go_image=$(jq -er '.runtimes.go.image' "$toolchain")

platforms="linux/amd64,linux/arm64"
output_dir=""
version="0.1.0-local.1"
allow_dirty=false
skip_image=false
repro_check=false
sign_key=""
rehearsal_sign=false

usage() {
  cat <<'USAGE'
usage: build-release-v0.sh [--output <dir>] [--platforms <csv>]
         [--version <v>] [--allow-dirty] [--skip-image]
         [--reproducibility-check] [--sign <ed25519-key-file>]
         [--rehearsal-sign]
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --output) output_dir=$2; shift 2 ;;
    --platforms) platforms=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --allow-dirty) allow_dirty=true; shift ;;
    --skip-image) skip_image=true; shift ;;
    --reproducibility-check) repro_check=true; shift ;;
    --sign) sign_key=$2; shift 2 ;;
    --rehearsal-sign) rehearsal_sign=true; shift ;;
    --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

for dependency in docker jq node git; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing release builder dependency: $dependency" >&2
    exit 1
  }
done

# Gated-inputs rule: a release build only ever consumes a committed tree, so
# every input went through the #121 gates for its commit.
if [ "$allow_dirty" != true ] && [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "release builds require a clean tree so gated inputs are exact; use --allow-dirty only for rehearsals" >&2
  exit 1
fi

commit=$(git -C "$repo_root" rev-parse HEAD)
epoch=$(git -C "$repo_root" show -s --format=%ct HEAD)
build_time=$(node -e "process.stdout.write(new Date($epoch * 1000).toISOString().replace(/\\.\\d{3}Z\$/u, 'Z'))")

if [ -z "$output_dir" ]; then
  output_dir="$script_dir/.artifacts/release-$version"
fi
mkdir -p "$output_dir"
case "$output_dir" in
  /*) : ;;
  *) output_dir=$(CDPATH= cd -- "$output_dir" && pwd) ;;
esac

echo "Torium release build: version=$version commit=$commit epoch=$epoch"
echo "output: $output_dir (publication is prohibited; local artifacts only)"

# build_binaries <destination-dir>
build_binaries() {
  destination=$1
  old_ifs=$IFS
  IFS=','
  for platform in $platforms; do
    IFS=$old_ifs
    platform_slug=$(printf '%s' "$platform" | tr '/' '-')
    platform_dir="$destination/binaries/$platform_slug"
    mkdir -p "$platform_dir"
    echo "building $platform binaries in the pinned toolchain container"
    # The shared module cache only accelerates verified-by-go.sum downloads;
    # it cannot change output bytes. The Go build cache stays cold on purpose.
    docker run --rm \
      --platform "$platform" \
      -v "$repo_root:/workspace" \
      -v "$platform_dir:/out" \
      -v torium-go-mod-cache:/go/pkg/mod \
      -e SOURCE_DATE_EPOCH="$epoch" \
      -w /workspace/chain/app \
      "$go_image" \
      sh -ec '
        apk add --no-cache build-base git linux-headers tar >/dev/null
        export GOFLAGS=-trimpath
        export CGO_ENABLED=1
        ldflags="-s -w \
          -X github.com/torium-network/torium-chain/internal/version.Version='"$version"' \
          -X github.com/torium-network/torium-chain/internal/version.Commit='"$commit"' \
          -X github.com/torium-network/torium-chain/internal/version.BuildTime='"$build_time"' \
          -X github.com/torium-network/torium-chain/internal/version.UpgradeProfile=pre"
        for binary in toriumd torium-genesis torium-localnet torium-localnet-state torium-faucet torium-public-faucet torium-archive-gateway; do
          go build -buildvcs=false -ldflags "$ldflags" -o "/tmp/$binary" "./cmd/$binary"
        done
        tar --sort=name --owner=0 --group=0 --numeric-owner \
          --mtime="@'"$epoch"'" \
          -C /tmp \
          -cf /tmp/bundle.tar \
          toriumd torium-genesis torium-localnet torium-localnet-state torium-faucet torium-public-faucet torium-archive-gateway
        gzip -n -9 -c /tmp/bundle.tar >"/out/torium-chain-'"$version"'-$(printf "%s" "'"$platform"'" | tr "/" "-").tar.gz"
        for binary in toriumd torium-genesis torium-localnet torium-localnet-state torium-faucet torium-public-faucet torium-archive-gateway; do
          cp "/tmp/$binary" /out/
        done
      '
    IFS=','
  done
  IFS=$old_ifs
}

# build_image <destination-dir> <extra-buildx-args>
build_image() {
  destination=$1
  extra=${2:-}
  mkdir -p "$destination/images"
  echo "building deterministic OCI image archive"
  # shellcheck disable=SC2086
  # Attestations are disabled: BuildKit stamps its own provenance/SBOM
  # attestation manifests with non-reproducible build metadata, and this
  # pipeline issues its own SLSA provenance and SPDX SBOM instead.
  SOURCE_DATE_EPOCH="$epoch" docker buildx build $extra \
    --provenance=false \
    --sbom=false \
    --file "$repo_root/chain/app/Dockerfile" \
    --platform "$platforms" \
    --build-arg VERSION="$version" \
    --build-arg COMMIT="$commit" \
    --build-arg BUILD_TIME="$build_time" \
    --build-arg UPGRADE_PROFILE=pre \
    --output "type=oci,dest=$destination/images/toriumd-$version.oci.tar,rewrite-timestamp=true" \
    "$repo_root/chain" >/dev/null
}

# write_sums <destination-dir>
write_sums() {
  destination=$1
  (
    cd "$destination"
    find binaries images -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r file; do
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file"
      else
        shasum -a 256 "$file"
      fi
    done >SHA256SUMS
  )
}

run_build() {
  destination=$1
  cache_args=${2:-}
  build_binaries "$destination"
  if [ "$skip_image" != true ]; then
    build_image "$destination" "$cache_args"
  fi
  write_sums "$destination"
}

run_build "$output_dir" ""

node "$script_dir/generate-sbom-v0.mjs" \
  --output "$output_dir/sbom.spdx.json" --version "$version" --epoch "$epoch"
node "$script_dir/generate-provenance-v0.mjs" \
  --sums "$output_dir/SHA256SUMS" --output "$output_dir/provenance-v1.json" \
  --commit "$commit" --version "$version" --epoch "$epoch" --platforms "$platforms"

if [ "$rehearsal_sign" = true ] && [ -z "$sign_key" ]; then
  echo "generating a VALUELESS throwaway rehearsal signing key (never reuse)"
  node "$script_dir/sign-release-v0.mjs" --generate-throwaway "$output_dir/rehearsal-signing.key"
  sign_key="$output_dir/rehearsal-signing.key"
fi
if [ -n "$sign_key" ]; then
  node "$script_dir/sign-release-v0.mjs" --key "$sign_key" --dir "$output_dir"
fi

if [ "$repro_check" = true ]; then
  echo "reproducibility check: rebuilding from scratch with --no-cache"
  second_dir="$output_dir-repro"
  rm -rf "$second_dir"
  mkdir -p "$second_dir"
  run_build "$second_dir" "--no-cache"
  if ! diff "$output_dir/SHA256SUMS" "$second_dir/SHA256SUMS"; then
    echo "REPRODUCIBILITY FAILURE: the two builds disagree" >&2
    exit 1
  fi
  echo "reproducibility check passed: both builds produced identical SHA256SUMS"
fi

node "$script_dir/verify-release-v0.mjs" --dir "$output_dir" --commit "$commit"
echo "release build complete: $output_dir"
echo "publication remains prohibited (release-pipeline-v0 HOLD)."
