SHELL := /bin/sh

APP_DIR := ../../app
RUNNER := ../tests/state-conformance/runner.go
SUITE_ROOT := ../tests/state-conformance

.PHONY: check test

check:
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run $(RUNNER) --root $(SUITE_ROOT) --verify-only

test:
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run $(RUNNER) --root $(SUITE_ROOT)
