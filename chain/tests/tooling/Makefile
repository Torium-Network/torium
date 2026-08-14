SHELL := /bin/sh

.PHONY: check test metamask

check:
	@sh -n run.sh
	@sh -n run-metamask.sh
	@npm run check

test:
	@./run.sh

metamask:
	@./run-metamask.sh
