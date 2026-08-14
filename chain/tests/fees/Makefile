SHELL := /bin/sh

.PHONY: check test

check:
	@node --check run.mjs
	@node ../../config/validate-protocol-v1.mjs >/dev/null
	@../../app/scripts/run-in-toolchain.sh gofmt -d ../tests/fees/txgen.go
	@../../app/scripts/run-in-toolchain.sh gofmt -d ../tests/fees/replaygen.go

test: check
	@node run.mjs
