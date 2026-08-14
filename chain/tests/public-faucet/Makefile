SHELL := /bin/sh

.PHONY: test check

test: check
	@./run.sh

check:
	@sh -n run.sh
	@node ../../config/validate-public-faucet-service-v0.mjs >/dev/null
	@node ../../../infra/torium/validate-faucet-design-v0.mjs >/dev/null
	@PF_SUITE_DIR=. PF_CHALLENGE_TOKEN=check TORIUM_UID=10001 TORIUM_GID=10001 \
		docker compose --file ../../localnet/compose.yaml --file compose.override.yaml config --quiet
