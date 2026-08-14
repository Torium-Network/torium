# Torium four-validator localnet

This directory runs the real `toriumd` state machine as four isolated
CometBFT validators. It is local development infrastructure only: tTOR has no
value, every key is a publicly reproducible disposable fixture, all host
listeners bind to loopback, and nothing connects to the Torium product backend
or a public network.

The topology is one developer-controlled authority domain, not a decentralized
network. Each validator has 25 of 100 voting power; commits require 67. The
network therefore continues with one validator unavailable (75 power) and
safely stops with any two unavailable (50 power). Broader partition and fault
ratification remains owned by a follow-up workstream.

## Quick start

From the repository root, start the complete network with one command:

```bash
./chain/localnet/torium-localnet start
```

Docker with Compose v2 is the default backend; host Go is not required.
The first run may pull the digest-pinned Go/Alpine images from a container
registry; once built, the chain itself requires no Torium backend or public
chain endpoint. The command does not return success until all four validators
are healthy, at least 67 of 100 voting power is available, the EVM RPC reports
chain ID `1414484556`, an increasing block height has been observed, and the
loopback-only valueless faucet reports ready.

The readiness report prints the Cosmos and EVM chain IDs, genesis SHA-256,
loopback endpoints, quorum, per-validator health, and public funded fixture
addresses. It always identifies the network as disposable and valueless. Pass
`--json` to `start`, `restart`, or `status` for a parseable report on stdout;
orchestration diagnostics remain on stderr.

Container validators and the faucet emit JSON logs with bounded Docker
`json-file` rotation (`10m`, three files). This is a local retention guard, not
a public log-retention policy. The inactive observability (metrics/log/alert) contract and
alert-response procedures are documented in the
[chain observability runbook](../../docs/operations/torium-chain-observability-runbook.md).

## Developer controls

```bash
./chain/localnet/torium-localnet status
./chain/localnet/torium-localnet status --json
./chain/localnet/torium-localnet logs --node validator-1
./chain/localnet/torium-localnet stop --node validator-3
./chain/localnet/torium-localnet restart --node validator-3
./chain/localnet/torium-localnet stop
./chain/localnet/torium-localnet start       # resumes preserved state
./chain/localnet/torium-localnet foreground  # attached logs; Ctrl-C preserves state
```

Commands remember the last selected backend, are safe to repeat, and report a
specific failing validator. Whole-network and per-node stop/restart operations
preserve databases and `priv_validator_state.json`. A normal `status` succeeds
for a degraded but live 75-power network; a node-specific status exits non-zero
when that node is unavailable.

For the container backend, a whole-network or `validator-0` restart brings the
validators back first, waits for chain readiness and observed block progress,
then restarts the dependent faucet. This avoids Compose's unordered `restart`
behavior leaving the one-shot faucet exited during validator startup.

Reset is deliberately destructive and separate from stop:

```bash
./chain/localnet/torium-localnet reset
# CI only, after reviewing the warning:
./chain/localnet/torium-localnet reset --yes
./chain/localnet/torium-localnet reset --node validator-3
```

It names the reused `torium-localnet-1` / `0x544f524c` replay domain and
requires typing `RESET`; non-interactive callers must pass `--yes`. Never reuse
the deterministic local keys or replay domain on a public or valuable network.

For versioned network/per-node snapshots, application export, offline state
inspection, atomic restore, named empty/funded/contracts/post-upgrade fixtures,
platform-specific volume cleanup, and the production boundary, see the
[local recovery guide](./RECOVERY.md).

Use `./chain/localnet/torium-localnet --help` for all options.

## Loopback interfaces

The public client surface belongs only to `validator-0`:

| Interface     | Host endpoint            |
| ------------- | ------------------------ |
| EVM JSON-RPC  | `http://127.0.0.1:8545`  |
| EVM WebSocket | `ws://127.0.0.1:8546`    |
| Cosmos REST   | `http://127.0.0.1:1317`  |
| Cosmos gRPC   | `127.0.0.1:9090`         |
| CometBFT RPC  | `http://127.0.0.1:26657` |
| Local faucet  | `http://127.0.0.1:8080`  |

Every validator exposes a loopback-only diagnostic CometBFT RPC and P2P port:

| Node          | CometBFT RPC | P2P host port | Client traffic |
| ------------- | -----------: | ------------: | -------------- |
| `validator-0` |        26657 |         26656 | yes            |
| `validator-1` |        26757 |         26756 | no             |
| `validator-2` |        26857 |         26856 | no             |
| `validator-3` |        26957 |         26956 | no             |

The chain ID is `torium-localnet-1`; the EVM chain ID is `1414484556`
(`0x544f524c`). No unsafe CometBFT RPC, wildcard CORS, insecure account unlock,
debug profiling, public bind, bridge, IBC transfer path, or hosted endpoint is
enabled.

## Local accounts and faucet

Fund a manual-test EVM address with the default 10 valueless tTOR, or request a
reviewed base-unit amount:

```bash
./chain/localnet/torium-localnet faucet 0x1111111111111111111111111111111111111111
./chain/localnet/torium-localnet faucet 0x1111111111111111111111111111111111111111 \
  --amount-base-units 2500000000000000000 --json
```

Every success is backed by a normal EIP-1559 transaction and confirmed receipt.
The public disposable genesis faucet signer exists only in process memory;
Compose supplies no key file, key volume, mnemonic, or private-key environment
variable. Port 8080 is published on loopback only and the service has no
persistent volume.

See [the account/keyring/faucet guide](./ACCOUNTS.md) for random manual
accounts, `os`/`file`/`test` boundaries, import/export/list/sign/balance,
transfer, staking and governance flows, address conversion, HTTP limits, and
reset behavior. This is not an internet-safe public faucet; a follow-up workstream owns that
separate design.

## Runtime preparation contract

`cmd/torium-localnet` derives four separate P2P keys and the four consensus
keys already committed by the canonical signed genesis transactions. It writes
runtime-only material under ignored `.state/<profile>/validator-N` homes and a
public `topology.json` inventory. Nothing in `.state` may be committed or
reused on a public or valuable network.

Preparation uses a staging directory. An ordinary rerun verifies the genesis,
keys, peer graph, configs and file modes, then leaves databases and signer
state untouched. Static drift fails closed with an instruction to inspect or
explicitly reset. A reset rebuilds byte-identical identities and a clean signer
state. Reset additionally requires a valid Torium topology marker in any
existing target directory; it refuses to delete an arbitrary path.

The container peer graph uses Compose DNS names. The raw profile uses
`127.0.0.1` and increments every node's base ports by 100. PEX is disabled,
duplicate loopback IPs are explicitly allowed, and every node persistently
dials the other three deterministic node IDs.

## Raw-binary fallback

Raw processes are useful for debugger/profiler work. Building them requires
native Go 1.25.9 and a C toolchain; the developer controller also requires
Node.js. The low-level `raw-status` Make target additionally uses `curl` and
`jq`:

```bash
make -C chain/app build
./chain/localnet/torium-localnet start --backend raw
./chain/localnet/torium-localnet status --backend raw
./chain/localnet/torium-localnet logs --backend raw --node validator-1
./chain/localnet/torium-localnet restart --backend raw --node validator-1
./chain/localnet/torium-localnet stop --backend raw
./chain/localnet/torium-localnet reset --backend raw
```

The controller validates that a PID belongs to the expected `toriumd --home`
before signaling it. It will not force-kill an unresponsive or unrelated
process. Logs and PID files live inside each ignored validator data directory.

## Low-level orchestration

The Make targets remain available for CI, smoke tests, and infrastructure
debugging. They do not provide the readiness or reset-confirmation contract of
the developer entrypoint:

```bash
make -C chain/localnet up
make -C chain/localnet status
make -C chain/localnet logs NODE=validator-1
make -C chain/localnet down
make -C chain/localnet raw-start
make -C chain/localnet raw-stop
```

## Deterministic consensus profile

The active local-only, unratified timeouts are:

| Parameter                   |         Value |
| --------------------------- | ------------: |
| `timeout_propose` / delta   |    1s / 500ms |
| `timeout_prevote` / delta   | 500ms / 250ms |
| `timeout_precommit` / delta | 500ms / 250ms |
| `timeout_commit`            |            2s |

These values are recorded in `chain/config/trust-model-v1.json`. A follow-up workstream must
measure them under load and a follow-up workstream must exercise the full fault matrix before
any public-environment ratification.

## Verification

Validate the complete local client endpoint contract:

```bash
make -C chain/tests/rpc test
```

This suite proves the required Ethereum HTTP methods, disabled privileged
namespaces, request limits, Cosmos REST/gRPC and Comet diagnostics, real
`newHeads`/`logs`/`newPendingTransactions` subscriptions, URL-form browser
Origin rejection, socket closure on restart, explicit reconnect and HTTP block
backfill. The exact profile is
`chain/config/rpc-profile-v1.json`. Cosmos EVM's permissive HTTP CORS default is
accepted only behind the local loopback publication boundary; it is explicitly
forbidden as a public profile.
See the
[local endpoint change record](../../docs/changes/2026-07-14-local-endpoint-contract.md)
for the compatibility and ownership boundaries.

Run the complete EVM application lifecycle from a clean Docker environment:

```bash
make -C chain/tests/e2e test
```

It transfers native tTOR, deploys and calls a test-only Solidity fixture,
verifies receipts/events/blocks/fees/nonces/finality on every validator,
exercises an expected revert, restarts the full network, proves persisted
state, finalizes another transaction, snapshots and restores real contract and
balance state, verifies application export, proves per-node reset/catch-up, and
rejects a corrupted archive without mutation. See the
[EVM lifecycle E2E contract](../tests/e2e/README.md) for exact assertions and
failure artefacts.

Prove the local faucet, keyring, and cross-interface balance contract:

```bash
make -C chain/tests/faucet test
```

It funds a random wallet, verifies the EIP-1559 transaction/receipt and
four-validator commit, matches Ethereum RPC, Cosmos REST, and `toriumd` CLI
balances, exercises a disposable deterministic `test` keyring plus offline
signing, and tests strict input/cooldown/amount behavior without exposing
secret-shaped request values.

Run the lower-level localnet resilience smoke test separately:

```bash
make -C chain/localnet smoke
```

It resets and starts all four real nodes, checks the canonical EVM chain ID,
compares a common block/app hash/validator set, submits a signed native
transfer, observes the same committed transaction on all four nodes, stops one
validator and proves continued progress, restarts it and proves catch-up,
checks identity isolation, then performs a clean reset and compares the
topology checksum. Services are stopped on success or failure.

For lower-level checks:

```bash
make -C chain/localnet check
make -C chain/app check-container
node chain/config/validate-trust-model-v1.mjs
docker compose -f chain/localnet/compose.yaml config --quiet
```

The architecture rationale is recorded in the
four-validator orchestration design,
and the delivered surfaces are indexed in the
[orchestration change note](../../docs/changes/2026-07-14-four-validator-localnet.md)
and [developer-control change note](../../docs/changes/2026-07-14-one-command-localnet.md).
The application lifecycle is indexed in the
[EVM lifecycle change note](../../docs/changes/2026-07-14-evm-lifecycle-e2e.md).
Validator admission, delegation, rewards, exit, slashing and key-safety
commands are in the
[validator lifecycle operator guide](../operator/VALIDATOR_LIFECYCLE.md).
