GO ?= go
BINARY ?= build/toriumd
GENESIS_BINARY ?= build/torium-genesis
LOCALNET_BINARY ?= build/torium-localnet
LOCALNET_STATE_BINARY ?= build/torium-localnet-state
FAUCET_BINARY ?= build/torium-faucet
PUBLIC_FAUCET_BINARY ?= build/torium-public-faucet
ARCHIVE_GATEWAY_BINARY ?= build/torium-archive-gateway
GENESIS_OUTPUT ?= ../genesis/localnet
VERSION ?= 0.1.0-local.1
COMMIT ?= development
BUILD_TIME ?= unknown
UPGRADE_PROFILE ?= pre
REPO_ROOT = $(shell git rev-parse --show-toplevel)
GOLANGCI_IMAGE := golangci/golangci-lint:v2.10.1-alpine@sha256:33bc6b6156d4c7da87175f187090019769903d04dd408833b83083ed214b0ddf
LDFLAGS := -s -w \
	-X github.com/torium-network/torium-chain/internal/version.Version=$(VERSION) \
	-X github.com/torium-network/torium-chain/internal/version.Commit=$(COMMIT) \
	-X github.com/torium-network/torium-chain/internal/version.BuildTime=$(BUILD_TIME) \
	-X github.com/torium-network/torium-chain/internal/version.UpgradeProfile=$(UPGRADE_PROFILE)

.PHONY: build check check-container container container-censor-fixture container-upgrade-pre container-upgrade-post container-upgrade-failed format generate genesis genesis-check lint lint-container test verify-go vet

verify-go:
	@./scripts/check-go-version.sh

format: verify-go
	@$(GO)fmt -w .

generate: verify-go
	@$(GO) generate ./...

genesis: verify-go
	@$(GO) run ./cmd/torium-genesis --output-dir $(GENESIS_OUTPUT)

genesis-check: verify-go
	@$(GO) run ./cmd/torium-genesis --output-dir $(GENESIS_OUTPUT) --check

test: verify-go
	@$(GO) test -count=1 ./...

vet: verify-go
	@$(GO) vet ./...

lint: vet

lint-container:
	@docker run --rm --entrypoint sh \
		-v "$(REPO_ROOT):/workspace" \
		-w /workspace/chain/app \
		$(GOLANGCI_IMAGE) \
		-c 'apk add --no-cache build-base linux-headers >/dev/null && golangci-lint run --timeout=10m ./...'

build: verify-go
	@mkdir -p $(dir $(BINARY))
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -ldflags '$(LDFLAGS)' -o $(BINARY) ./cmd/toriumd
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -o $(GENESIS_BINARY) ./cmd/torium-genesis
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -ldflags '$(LDFLAGS)' -o $(LOCALNET_BINARY) ./cmd/torium-localnet
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -ldflags '$(LDFLAGS)' -o $(LOCALNET_STATE_BINARY) ./cmd/torium-localnet-state
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -ldflags '-s -w' -o $(FAUCET_BINARY) ./cmd/torium-faucet
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -ldflags '-s -w' -o $(PUBLIC_FAUCET_BINARY) ./cmd/torium-public-faucet
	@CGO_ENABLED=1 $(GO) build -trimpath -buildvcs=false -ldflags '-s -w' -o $(ARCHIVE_GATEWAY_BINARY) ./cmd/torium-archive-gateway

check:
	@./scripts/check.sh

check-container:
	@./scripts/run-in-toolchain.sh make check
	@$(MAKE) lint-container

container:
	@docker build --file Dockerfile --tag toriumd:local \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		--build-arg UPGRADE_PROFILE=$(UPGRADE_PROFILE) ..

# The #119 proposer-censorship drill image. CENSOR_FIXTURE is the only place in
# this repository that passes the build tag, and the image is tagged distinctly
# so it can never be mistaken for a release artifact.
CENSOR_FIXTURE_TAG ?= toriumcensorfixture
container-censor-fixture:
	@docker build --file Dockerfile --tag toriumd:censor-fixture \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		--build-arg UPGRADE_PROFILE=$(UPGRADE_PROFILE) \
		--build-arg GO_BUILD_TAGS=$(CENSOR_FIXTURE_TAG) ..

container-upgrade-pre:
	@$(MAKE) --no-print-directory container VERSION=0.1.0-local.1 UPGRADE_PROFILE=pre
	@docker tag toriumd:local toriumd:upgrade-pre

container-upgrade-post:
	@docker build --file Dockerfile --tag toriumd:upgrade-post \
		--build-arg VERSION=0.2.0-local.1 \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		--build-arg UPGRADE_PROFILE=post ..

container-upgrade-failed:
	@docker build --file Dockerfile --tag toriumd:upgrade-failed \
		--build-arg VERSION=0.2.0-local.1 \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		--build-arg UPGRADE_PROFILE=failed-rehearsal ..
