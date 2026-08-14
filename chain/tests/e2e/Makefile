SHELL := /bin/sh

.PHONY: check test

check:
	@sh -n run.sh
	@jq -e '.schemaVersion == 1 and .contractName == "CompatibilityProbe" and .compiler.version == "0.8.30" and .testTool.version == "1.7.1" and (.creationBytecode | test("^0x[0-9a-f]+$$")) and (.deployedBytecode | test("^0x[0-9a-f]+$$"))' fixtures/CompatibilityProbe.json >/dev/null

test: check
	@./run.sh
