# syntax=docker/dockerfile:1.7
FROM golang:1.25.9-alpine3.23@sha256:5caaf1cca9dc351e13deafbc3879fd4754801acba8653fa9540cea125d01a71f AS build

RUN apk add --no-cache build-base git linux-headers
WORKDIR /src/app

COPY app/go.mod app/go.sum ./
RUN go mod download

COPY app/ ./
COPY config/protocol-v1.json config/governance-v1.json config/faucet-policy-v1.json ../config/
# The archive gateway derives its method allowlist from the reviewed node-role
# profile; its contract test reads the file during the build.
COPY profiles/node-roles-v0.json ../profiles/
COPY genesis/ ../genesis/

ARG VERSION=0.1.0-local.1
ARG COMMIT=development
ARG BUILD_TIME=unknown
ARG UPGRADE_PROFILE=pre
# GO_BUILD_TAGS is EMPTY for every release and container build. The only
# consumer is chain/app's `container-censor-fixture` target, which passes the
# #119 proposer-censorship tag to produce a distinctly tagged drill image.
# chain/scripts/check-boundaries.mjs asserts no release path sets it.
ARG GO_BUILD_TAGS=""

RUN go test -count=1 -tags "${GO_BUILD_TAGS}" ./... && \
    CGO_ENABLED=1 go build \
      -tags "${GO_BUILD_TAGS}" \
      -trimpath \
      -buildvcs=false \
      -ldflags "-s -w \
        -X github.com/torium-network/torium-chain/internal/version.Version=${VERSION} \
        -X github.com/torium-network/torium-chain/internal/version.Commit=${COMMIT} \
        -X github.com/torium-network/torium-chain/internal/version.BuildTime=${BUILD_TIME} \
        -X github.com/torium-network/torium-chain/internal/version.UpgradeProfile=${UPGRADE_PROFILE}" \
      -o /out/toriumd ./cmd/toriumd && \
    CGO_ENABLED=1 go build \
      -trimpath \
      -buildvcs=false \
      -ldflags "-s -w" \
      -o /out/torium-faucet ./cmd/torium-faucet && \
    CGO_ENABLED=1 go build \
      -trimpath \
      -buildvcs=false \
      -ldflags "-s -w" \
      -o /out/torium-public-faucet ./cmd/torium-public-faucet && \
    CGO_ENABLED=1 go build \
      -trimpath \
      -buildvcs=false \
      -ldflags "-s -w" \
      -o /out/torium-archive-gateway ./cmd/torium-archive-gateway

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

# apk records the wall-clock time of each install in /var/log/apk.log, which
# makes the runtime layer non-reproducible; it is removed in the same layer.
RUN apk add --no-cache ca-certificates libgcc libstdc++ && \
    addgroup -S -g 10001 torium && \
    adduser -S -D -H -u 10001 -G torium torium && \
    mkdir -p /var/lib/torium && \
    chown torium:torium /var/lib/torium && \
    rm -f /var/log/apk.log

COPY --from=build /out/toriumd /usr/local/bin/toriumd
COPY --from=build /out/torium-faucet /usr/local/bin/torium-faucet
COPY --from=build /out/torium-public-faucet /usr/local/bin/torium-public-faucet
COPY --from=build /out/torium-archive-gateway /usr/local/bin/torium-archive-gateway

ENV HOME=/var/lib/torium
USER 10001:10001
VOLUME ["/var/lib/torium"]
EXPOSE 1317 8080 8545 8546 9090 26656 26657
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:26657/health || exit 1

ENTRYPOINT ["toriumd"]
CMD ["start", "--home", "/var/lib/torium"]
