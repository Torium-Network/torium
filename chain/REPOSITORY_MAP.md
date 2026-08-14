# Torium EVM repository map

Status: accepted for local-first development on 2026-07-14.

The chain, contracts, SDK, examples and developer docs live in this repository.
They do not import from, start, deploy or authenticate against the Torium
product backend.

## Owned surfaces

| Path                   | Purpose                                                               | Canonical source                         |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `chain/app/`           | Cosmos SDK application composition and Go modules                     | Go source and `go.mod`                   |
| `chain/config/`        | Versioned protocol, identifier, endpoint, and local-service contracts | reviewed JSON manifests                  |
| `chain/environments/`  | Non-secret local/dev/test/main configuration overlays                 | reviewed config files                    |
| `chain/explorer/`      | Local explorer selection, inactive stack inventory and validation     | reviewed manifests and validators        |
| `chain/genesis/`       | Generated public genesis artifacts and checksums                      | local fixture plus node module defaults  |
| `chain/localnet/`      | Reproducible validator orchestration and local fixtures               | scripts and Compose files                |
| `chain/observability/` | Local health metrics, log, alert and dashboard contracts              | reviewed manifests, code and validators  |
| `chain/operator/`      | Validator lifecycle and offline signer-state operator guards          | reviewed runbooks and guard code         |
| `chain/performance/`   | Local workload/result contracts and offline performance validation    | reviewed manifests, schemas and validators |
| `chain/poc/`           | Time-bounded spikes; never a release input by default                 | each PoC README                          |
| `chain/profiles/`      | Versioned validator, sentry, query, RPC, and archive role targets     | reviewed manifests and validators        |
| `chain/recovery/`      | Operator snapshot, state-sync, backup, retention and restore gates    | reviewed manifests and validators        |
| `chain/releases/`      | Generated environment-separated network/release metadata             | deterministic generator, schema and sums |
| `chain/resilience/`    | Local finality/recovery scenario and result evidence contracts        | reviewed manifests, schemas and validator |
| `chain/security/`      | Threat, secret, custody, risk/test ownership and release gates        | versioned manifests and validators       |
| `chain/scripts/`       | Bootstrap, generation, boundary and conformance tooling               | scripts in this directory                |
| `chain/tests/`         | Chain lifecycle, JSON-RPC, and local-faucet acceptance suites         | test sources                             |
| `contracts/`           | Solidity source, tests, deploy scripts and contract build config      | Solidity source                          |
| `packages/torium-sdk/` | Unpublished TypeScript SDK source and generated clients               | handwritten source plus generated inputs |
| `apps/developer-docs/` | `torium.network/docs` application                                     | MDX/content source                       |
| `examples/torium/`     | Copyable SDK and contract examples                                    | example source                           |

Reserved paths do not have to exist before their owner issue starts. Empty
directory scaffolding is intentionally avoided.

## Explicit non-dependencies

- The chain build must not depend on `packages/backend`, Clerk, PostgreSQL,
  Redis, BullMQ, the native app or any Torium product API.
- The SDK's base EVM surface talks directly to JSON-RPC/WebSocket endpoints.
  A future Torium-product adapter must be optional and live behind a separate
  entry point.
- Chain commits never carry `!deploy-backend`, frontend deploy flags or OTA
  publish instructions. Chain paths are not backend deployment path filters.
- Bridge and IBC product work is outside the current roadmap. The upstream IBC
  module may remain buildable only if the chain composition requires it; no
  public channel, relayer or user-facing IBC promise is made.

## Generated artifact ownership

| Generated output    | Source of truth                                     | Consumer               | Rule                                                                                                      |
| ------------------- | --------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Go protobuf         | proto sources in `chain/app/`                       | chain binary           | generated beside the owning Go module; never hand-edit                                                    |
| SDK protobuf/types  | proto/OpenAPI sources in `chain/app/`               | `packages/torium-sdk`  | generated into `src/generated`; never hand-edit                                                           |
| Contract ABI        | `contracts/src` plus compiler config                | SDK, docs, examples    | generated into the contract artifact area, then copied by a checked generator                             |
| Deployment registry | reviewed environment deployment record              | SDK and docs           | environment keyed, checksummed and generated; local records cannot become public defaults                 |
| Localnet genesis    | `chain/app/localnet/fixture.json` plus app defaults | node and local tooling | generated by `torium-genesis`; byte-for-byte regeneration, binary validation and SHA-256 checks must pass |
| Docs API reference  | SDK public exports and schemas                      | developer docs         | generation must fail on drift or broken links                                                             |

Generators must run with the versions in `chain/toolchain.json`, write to a
temporary directory, and replace committed artifacts only after successful
generation. CI will regenerate and fail on a dirty diff. Every generated file
must contain a `DO NOT EDIT` marker and identify its generator or source.

## Extraction gate

Re-evaluate a dedicated chain repository before public testnet. Extract when at
least one condition is material:

1. independent chain/SDK release cadence needs permissions or tags that cannot
   be isolated safely here;
2. an external audit needs a frozen, smaller source boundary;
3. separate maintainers require branch protection or CODEOWNERS that cannot be
   represented in this repository;
4. chain CI or history creates unacceptable latency/size for the product apps;
5. public node operations require secrets or deployment access that product
   maintainers must not hold.

Extraction must preserve Git history, canonical identifiers, artifact checksums
and documentation URLs. Until then, atomic changes across chain schemas, SDK
generation and docs are more valuable than repository separation.
