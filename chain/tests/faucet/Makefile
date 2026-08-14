SHELL := /bin/sh

.PHONY: test check

test: check
	@./run.sh

check:
	@sh -n run.sh
	@node ../../config/validate-faucet-policy-v1.mjs >/dev/null
