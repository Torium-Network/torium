SHELL := /bin/sh

TOOLCHAIN := ./scripts/run-in-toolchain.sh
SOLC_FLAGS := --use /opt/torium-solc --offline --no-auto-detect --out .work/out --cache-path .work/cache
COVERAGE_MINIMUM := $(shell node -e 'const m=require("../chain/toolchain.json"); process.stdout.write(String(m.contracts.coverage.minimumLinePercent))')

.DEFAULT_GOAL := check
.NOTPARALLEL: check local

.PHONY: check local verify deps fmt lint build test fixture-test gas-snapshot-check coverage generate generate-check validate audit-bundle clean

verify:
	@$(TOOLCHAIN) verify

deps:
	@$(TOOLCHAIN) deps

fmt:
	@$(TOOLCHAIN) foundry forge fmt --check

lint: deps
	@$(TOOLCHAIN) npm run lint
	@$(TOOLCHAIN) foundry forge lint $(SOLC_FLAGS) --deny warnings

build: deps
	@$(TOOLCHAIN) foundry forge build $(SOLC_FLAGS) --force

test: build
	@$(TOOLCHAIN) foundry forge test $(SOLC_FLAGS)

# Fixture tests run in the pinned Node image after dependency installation, but
# the test process itself has a read-only repository mount and no network.
fixture-test: deps
	@./scripts/run-node-offline.sh node --test \
		scripts/generate-reward-fixture.test.mjs \
		scripts/validate-attestation-vectors.test.mjs

# These focused benchmarks intentionally repeat only eight small test entry
# points. Keeping the snapshots in the canonical gate prevents gas evidence
# from drifting while the broader suite still runs exactly once.
gas-snapshot-check: build
	@$(TOOLCHAIN) foundry forge snapshot $(SOLC_FLAGS) \
		--match-path test/attestations/ToriumAttestationRegistry.t.sol \
		--match-test '^testGas' \
		--check gas-snapshots/attestation-registry-v1.snapshot
	@$(TOOLCHAIN) foundry forge snapshot $(SOLC_FLAGS) \
		--match-path 'test/assurance/*.t.sol' \
		--match-test '^testGas' \
		--check gas-snapshots/system-contracts-assurance-v0.snapshot

coverage: build
	@mkdir -p .artifacts
	@set -eu; \
		output="$$( $(TOOLCHAIN) foundry forge coverage $(SOLC_FLAGS) --report summary 2>&1 )"; \
		printf '%s\n' "$$output" | tee .artifacts/coverage-summary.txt; \
		actual="$$(printf '%s\n' "$$output" | awk -F '|' '$$2 ~ /^[[:space:]]*Total[[:space:]]*$$/ { value=$$3; sub(/%.*/, "", value); gsub(/[[:space:]]/, "", value); print value; exit }')"; \
		if [ -z "$$actual" ]; then \
			echo "Unable to read total line coverage from forge coverage output" >&2; \
			exit 1; \
		fi; \
		awk -v actual="$$actual" -v minimum="$(COVERAGE_MINIMUM)" 'BEGIN { if ((actual + 0) < (minimum + 0)) { printf "Line coverage %.2f%% is below required %.2f%%\n", actual, minimum > "/dev/stderr"; exit 1 } }'; \
		printf 'Line coverage %.2f%% meets required %.2f%%\n' "$$actual" "$(COVERAGE_MINIMUM)"

generate: build
	@$(TOOLCHAIN) npm run generate

generate-check: build
	@$(TOOLCHAIN) npm run generate:check

validate: deps
	@$(TOOLCHAIN) npm run validate:registry

# Produces ignored, self-verifying handoff evidence with the digest-pinned Node
# runtime and no network. The second pass proves deterministic reproduction.
audit-bundle: coverage
	@./scripts/run-audit-bundle-offline.sh
	@./scripts/run-audit-bundle-offline.sh --check

# This target is deliberately RPC-free. It may download only the digest-pinned
# tool images and the exact npm packages recorded in package-lock.json.
check: verify fmt lint test fixture-test coverage generate-check validate gas-snapshot-check audit-bundle

# The local acceptance regenerates reviewed canonical consumers, verifies their
# drift, then owns one short-lived Anvil instance. It is never used by `check`
# or CI and writes runtime evidence only under .artifacts.
local: verify fmt lint test coverage generate generate-check validate
	@./scripts/local.sh

clean:
	@rm -rf cache out .work .artifacts
