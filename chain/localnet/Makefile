SHELL := /bin/sh

LOCALNET_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
CHAIN_DIR := $(abspath $(LOCALNET_DIR)/..)
APP_DIR := $(CHAIN_DIR)/app
COMPOSE := docker compose --file $(LOCALNET_DIR)/compose.yaml
# The #114 archive lane is an overlay, so the four-validator localnet contract
# stays untouched. NOTE: plain `up`/`down` use --remove-orphans and therefore
# tear the archive services down; re-run `archive-up` after restarting the
# localnet.
ARCHIVE_COMPOSE := $(COMPOSE) --file $(CHAIN_DIR)/profiles/compose.archive-gateway.yaml
ARCHIVE_SERVICES := private-archive-indexer archive-rpc-gateway
STATE_DIR := $(LOCALNET_DIR)/.state
HOST_UID := $(shell id -u)
HOST_GID := $(shell id -g)
ALPINE_IMAGE := alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
TORIUMD_BINARY ?= $(APP_DIR)/build/toriumd
LOCALNET_BINARY ?= $(APP_DIR)/build/torium-localnet
NODE ?=
VALIDATORS := validator-0 validator-1 validator-2 validator-3

.PHONY: check prepare prepare-container prepare-raw prepare-archive image up foreground down start stop restart faucet-restart status logs reset reset-node reset-archive archive-up archive-down archive-status archive-logs smoke raw-start raw-stop raw-restart raw-status raw-logs raw-reset raw-reset-node

check:
	@sh -n $(LOCALNET_DIR)/torium-localnet $(LOCALNET_DIR)/scripts/raw-control.sh $(LOCALNET_DIR)/scripts/smoke.sh
	@node --test $(LOCALNET_DIR)/scripts/health.test.mjs
	@node $(CHAIN_DIR)/config/validate-rpc-profile-v1.mjs >/dev/null
	@node $(CHAIN_DIR)/config/validate-faucet-policy-v1.mjs >/dev/null
	@node $(CHAIN_DIR)/config/validate-governance-v1.mjs >/dev/null
	@node --check $(LOCALNET_DIR)/scripts/faucet-request.mjs
	@node --check $(CHAIN_DIR)/tests/rpc/probe.mjs
	@node --check $(CHAIN_DIR)/operator/verify-upgrade-binary.mjs
	@sh -n $(CHAIN_DIR)/tests/rpc/run.sh
	@sh -n $(CHAIN_DIR)/tests/faucet/run.sh
	@sh -n $(CHAIN_DIR)/tests/governance-upgrade/run.sh
	@sh -n $(CHAIN_DIR)/tests/public-faucet/run.sh
	@node $(CHAIN_DIR)/config/validate-public-faucet-service-v0.mjs >/dev/null
	@$(COMPOSE) config --quiet
	@$(COMPOSE) --file $(CHAIN_DIR)/tests/governance-upgrade/compose.override.yaml config --quiet
	@PF_SUITE_DIR=$(CHAIN_DIR)/tests/public-faucet PF_CHALLENGE_TOKEN=check \
		$(COMPOSE) --file $(CHAIN_DIR)/tests/public-faucet/compose.override.yaml config --quiet
	@$(ARCHIVE_COMPOSE) config --quiet
	@sh -n $(CHAIN_DIR)/profiles/run-archive-gateway-evidence-v0.sh
	@node $(CHAIN_DIR)/profiles/validate-node-roles-v0.mjs >/dev/null
	@$(LOCALNET_DIR)/torium-localnet --help >/dev/null

prepare: prepare-container

prepare-container:
	@mkdir -p "$(STATE_DIR)"
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run ./cmd/torium-localnet \
		--root ../localnet/.state/container --profile container
	@docker run --rm -v "$(STATE_DIR)/container:/state" $(ALPINE_IMAGE) \
		chown -R $(HOST_UID):$(HOST_GID) /state

prepare-archive:
	@test -d "$(STATE_DIR)/container" || { \
		echo "prepare the four-validator runtime first: make -C chain/localnet prepare" >&2; \
		exit 64; \
	}
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run ./cmd/torium-localnet \
		--root ../localnet/.state/container --profile container --archive
	@docker run --rm -v "$(STATE_DIR)/container:/state" $(ALPINE_IMAGE) \
		chown -R $(HOST_UID):$(HOST_GID) /state

prepare-raw:
	@test -x "$(LOCALNET_BINARY)" || { \
		echo "missing native helper $(LOCALNET_BINARY); run 'make -C chain/app build' with Go 1.25.9" >&2; \
		exit 1; \
	}
	@"$(LOCALNET_BINARY)" --root "$(STATE_DIR)/raw" --profile raw

image:
	@$(MAKE) --no-print-directory -C $(APP_DIR) container

up: prepare image
	@TORIUM_UID=$(HOST_UID) TORIUM_GID=$(HOST_GID) $(COMPOSE) up --detach --remove-orphans

foreground:
	@TORIUM_UID=$(HOST_UID) TORIUM_GID=$(HOST_GID) $(COMPOSE) up --remove-orphans

down:
	@$(COMPOSE) down --remove-orphans

start:
	@TORIUM_UID=$(HOST_UID) TORIUM_GID=$(HOST_GID) $(COMPOSE) start $(NODE)

stop:
	@$(COMPOSE) stop $(NODE)

restart:
	@$(if $(NODE),$(COMPOSE) stop $(NODE) && $(COMPOSE) start $(NODE),$(COMPOSE) restart $(VALIDATORS))

faucet-restart:
	@$(COMPOSE) restart faucet

status:
	@$(COMPOSE) ps $(NODE)

logs:
	@$(COMPOSE) logs --follow --tail=200 $(NODE)

reset: down
	@mkdir -p "$(STATE_DIR)"
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run ./cmd/torium-localnet \
		--root ../localnet/.state/container --profile container --reset
	@docker run --rm -v "$(STATE_DIR)/container:/state" $(ALPINE_IMAGE) \
		chown -R $(HOST_UID):$(HOST_GID) /state

reset-node:
	@test -n "$(NODE)" || { echo "NODE=validator-N is required" >&2; exit 64; }
	@$(COMPOSE) stop $(NODE)
	@$(COMPOSE) rm --force --stop $(NODE)
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run ./cmd/torium-localnet \
		--root ../localnet/.state/container --profile container --reset-node "$(NODE)"
	@docker run --rm -v "$(STATE_DIR)/container:/state" $(ALPINE_IMAGE) \
		chown -R $(HOST_UID):$(HOST_GID) /state
	@TORIUM_UID=$(HOST_UID) TORIUM_GID=$(HOST_GID) $(COMPOSE) create --no-build $(NODE)

reset-archive: archive-down
	@$(APP_DIR)/scripts/run-in-toolchain.sh go run ./cmd/torium-localnet \
		--root ../localnet/.state/container --profile container --reset-archive
	@docker run --rm -v "$(STATE_DIR)/container:/state" $(ALPINE_IMAGE) \
		chown -R $(HOST_UID):$(HOST_GID) /state

archive-up: prepare-archive image
	@TORIUM_UID=$(HOST_UID) TORIUM_GID=$(HOST_GID) \
		$(ARCHIVE_COMPOSE) up --detach --wait $(ARCHIVE_SERVICES)

archive-down:
	@$(ARCHIVE_COMPOSE) rm --force --stop --volumes $(ARCHIVE_SERVICES) >/dev/null 2>&1 || true

archive-status:
	@$(ARCHIVE_COMPOSE) ps $(ARCHIVE_SERVICES)

archive-logs:
	@$(ARCHIVE_COMPOSE) logs --tail=200 $(ARCHIVE_SERVICES)

smoke:
	@$(LOCALNET_DIR)/scripts/smoke.sh

raw-start: prepare-raw
	@TORIUMD_BINARY="$(TORIUMD_BINARY)" $(LOCALNET_DIR)/scripts/raw-control.sh start $(NODE)

raw-stop:
	@TORIUMD_BINARY="$(TORIUMD_BINARY)" $(LOCALNET_DIR)/scripts/raw-control.sh stop $(NODE)

raw-restart: prepare-raw
	@TORIUMD_BINARY="$(TORIUMD_BINARY)" $(LOCALNET_DIR)/scripts/raw-control.sh restart $(NODE)

raw-status:
	@TORIUMD_BINARY="$(TORIUMD_BINARY)" $(LOCALNET_DIR)/scripts/raw-control.sh status $(NODE)

raw-logs:
	@TORIUMD_BINARY="$(TORIUMD_BINARY)" $(LOCALNET_DIR)/scripts/raw-control.sh logs $(NODE)

raw-reset: raw-stop
	@test -x "$(LOCALNET_BINARY)" || { \
		echo "missing native helper $(LOCALNET_BINARY); run 'make -C chain/app build' with Go 1.25.9" >&2; \
		exit 1; \
	}
	@"$(LOCALNET_BINARY)" --root "$(STATE_DIR)/raw" --profile raw --reset

raw-reset-node:
	@test -n "$(NODE)" || { echo "NODE=validator-N is required" >&2; exit 64; }
	@TORIUMD_BINARY="$(TORIUMD_BINARY)" $(LOCALNET_DIR)/scripts/raw-control.sh stop "$(NODE)"
	@test -x "$(LOCALNET_BINARY)" || { \
		echo "missing native helper $(LOCALNET_BINARY); run 'make -C chain/app build' with Go 1.25.9" >&2; \
		exit 1; \
	}
	@"$(LOCALNET_BINARY)" --root "$(STATE_DIR)/raw" --profile raw --reset-node "$(NODE)"
