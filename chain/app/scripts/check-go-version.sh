#!/bin/sh
set -eu

required="go1.25.9"
actual="$(go env GOVERSION)"

if [ "$actual" != "$required" ]; then
  echo "Torium chain requires $required exactly; found $actual" >&2
  echo "Run ./scripts/run-in-toolchain.sh <command> for the pinned container." >&2
  exit 1
fi
