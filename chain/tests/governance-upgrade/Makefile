SHELL := /bin/sh

.PHONY: check test

check:
	@sh -n run.sh
	@node --check ../../operator/verify-upgrade-binary.mjs
	@docker compose --file ../../localnet/compose.yaml --file compose.override.yaml config --quiet
	@node ../../config/validate-governance-v1.mjs >/dev/null

test: check
	@./run.sh
