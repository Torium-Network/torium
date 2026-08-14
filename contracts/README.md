# Torium contracts workspace

Status: local-development contract workspace for the contracts workstreams. Nothing in this directory
is a public-network deployment or an authorization to deploy.

This workspace owns Torium-authored Solidity source, Foundry tests, component
classification, deployment-registry schemas and reproducible generated
artifacts. Compiler and dependency versions are pinned by
[`chain/toolchain.json`](../chain/toolchain.json) and repeated in the contract
configuration so a build cannot silently select a different toolchain.

## Current boundary

| Component                  | Classification                                              | Current status                                                                                                     |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Native TOR Solidity facade | Protocol precompile backed by the canonical `x/bank` ledger | Active in the local chain; `IToriumNative` is only its Solidity interface, not deployable Torium bytecode          |
| `ToriumCreate2Factory`     | Application-level deterministic post-genesis contract       | Source and local tests exist; deployment remains planned                                                           |
| Reward distributor         | Application-level deterministic post-genesis contract       | Merkle-sum implementation and offline fixtures exist; address, authority assignments and deployment remain planned |
| Attestation registry       | Application-level deterministic post-genesis contract       | Hash-only implementation, canonical vectors and gas snapshot exist; deployment remains planned                     |

Torium currently has no Torium-authored Solidity contract allocated into
genesis. The native facade is protocol-owned precompile behavior assembled by
the chain, not a Solidity genesis predeploy. A future exception requires a new
ADR plus deterministic state allocation, bytecode/storage fixtures, upgrade
rules and EVM conformance evidence.

The CREATE2 factory establishes a role-free, versioned deployment plan. It is
not present in genesis and this workspace does not publish a deployed factory
address, deployment transaction, signer, private key or privileged role.

The reward distributor binds each funded epoch to a Merkle-sum root, so the
committed aggregate liability must equal the native value supplied at
publication. This does not validate the publisher's allocation policy. The
publisher remains responsible for the reviewed recipient/amount dataset, and
no publisher, treasury, pauser, administrator or clawback operator is assigned
by the generated localnet registry.

The attestation registry is permissionless and self-issued: the transaction
sender is the issuer, with no owner, issuer allowlist or backend identity map.
It stores identifiers and hashes only. Hashes are not anonymization, proof of
truth or legal timestamps; sensitive payloads and plaintext metadata URIs must
remain off-chain.

The localnet bootstrap prediction uses the existing public, valueless
`deployer` fixture at nonce zero; it is not a dedicated production authority.
Resolution is fail-closed: matching code at the predicted address is reused,
an empty address is deployable only while that fixture nonce is exactly zero,
and any other code or nonce requires a clean localnet reset or a new reviewed
deployment plan. Public environments must define a separate authority and
provenance before any broadcast.

## Layout

- `src/interfaces/` contains stable Solidity integration interfaces.
- `src/deployment/` contains deterministic deployment infrastructure source.
- `src/rewards/` contains the backend-agnostic native reward primitive.
- `src/attestations/` contains the generic hash-only attestation primitive.
- `test/` contains unit, fuzz, invariant and deployment-behavior tests.
- `fixtures/rewards/` contains deterministic example inputs and generated
  Merkle-sum proof vectors.
- `fixtures/attestations/` contains exact-byte and ABI hashing vectors; it does
  not apply hidden JSON, Unicode or URI normalization.
- `gas-snapshots/` contains pinned benchmark evidence, not production fee
  estimates.
- `scripts/audit-bundle.config.json` defines the exact v0 review input scope;
  the offline runner emits ignored manifests under `.artifacts/audit/`.
- `config/` classifies protocol and post-genesis components.
- `deployments/` defines the versioned deployment-registry contract.
- `generated/` is generator-owned ABI and registry output; never hand-edit it.
- `script/` is reserved for reviewed post-genesis deployment automation. It
  must consume caller-provided RPC/signing configuration and must never contain
  keys.

Foundry `out/`, cache, broadcast data and local work directories are disposable
and ignored. Generated, reviewed artifacts are separate from those raw build
outputs.

## Local verification

From the repository root, run:

```bash
make -C contracts check
```

The check target is the one local/CI contract gate. It validates the pinned
configuration and component decision, formats and builds Solidity, runs tests
and static checks, enforces the attestation and system-contract gas snapshots,
runs reward and attestation fixture tests in a
network-disabled container,
validates registry data, regenerates artifacts in check mode
and rejects drift. Its last step creates the ignored audit manifest twice in a
digest-pinned, network-disabled Node container and rejects nondeterminism. It
does not start the Torium chain, use a public RPC, request a key or deploy a
contract.

Generate a reviewed reward fixture from strict CSV or JSON input with the
pinned workspace dependencies:

```bash
cd contracts
node scripts/generate-reward-fixture.mjs \
  --input fixtures/rewards/example.csv \
  --output /tmp/torium-reward-epoch.json \
  --epoch-id 7
```

The generator sorts claims deterministically, rejects duplicate indices and
accounts, checks all values against `uint256`, and emits sibling hashes plus
sibling sums for every proof. Its test suite regenerates the committed vector
inside the digest-pinned Node container with `--network none`.

After changing contract storage, runtime behavior or compiler settings, compare
the eight focused benchmark cases with the committed snapshots:

```bash
make -C contracts gas-snapshot-check
```

This benchmark does not contact a chain. `check` runs the same target as a
mandatory drift gate; call it directly only when reviewing or updating gas
evidence without rerunning the broader suite.

The ignored audit bundle can also be regenerated directly, without RPC or
network access:

```bash
make -C contracts audit-bundle
```

This target refreshes the offline coverage summary first. The manifest records
only normalized totals; volatile test durations and raw terminal output never
enter the primary scope digest.

The manifest records the current Git commit/tree as runtime metadata and uses
its SHA-256 scope digest as the primary content identity, avoiding a tracked
self-reference. A dirty-worktree manifest explicitly lists paths that do not
match `HEAD` and is development evidence only. A follow-up workstream must regenerate and record
the final merge commit and digest from a clean checkout before any external
bundle.

For the bounded deployment acceptance, run this once **instead of** a separate
`check` invocation:

```bash
make -C contracts local
```

`local` runs the static gates, regenerates and drift-checks the canonical
ABI/SDK/docs consumers, then starts one short-lived Anvil process with no
generated accounts. It auto-impersonates only the valueless canonical localnet
fixture address, deploys the factory and a CREATE2 fixture, resolves the same
fixture a second time, and verifies addresses, configuration and runtime
hashes. It writes ignored proof under
`contracts/.artifacts/local-acceptance/`, marks it noncanonical, and always
removes the node. It does not run MetaMask or modify Torium localnet. Avoid
running `check` and `local` back-to-back unless inputs changed.

Any future deployment command must require an explicit environment and chain
identity, obtain signing material outside the repository, verify runtime
bytecode, and emit a non-secret registry record. A local record cannot be
promoted into public documentation by changing a label.

## Sources of truth

- [`config/components-v1.json`](config/components-v1.json) records the
  precompile versus post-genesis decision.
- [`deployments/deployment-registry-v1.schema.json`](deployments/deployment-registry-v1.schema.json)
  defines deployment provenance without inventing a deployment.
- [`../apps/developer-docs/content/generated/contracts-localnet-foundation.json`](../apps/developer-docs/content/generated/contracts-localnet-foundation.json)
  is the checked, non-release docs consumer of generated artifact identity.
- [`interfaces/README.md`](interfaces/README.md) documents the native facade
  interface and its single-ledger behavior.
