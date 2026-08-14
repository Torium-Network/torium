# Torium EVM lifecycle E2E

This suite proves that the standalone Torium EVM L1 can execute a complete
application lifecycle on the canonical four-validator localnet. It uses only
loopback endpoints and disposable, valueless fixture accounts. It does not
contact the Torium product backend, a public chain, a bridge, or a hosted RPC.

## Run it

From a clean checkout at the repository root:

```bash
make -C chain/tests/e2e test
```

The host needs Docker with Compose v2, `curl`, `jq`, `make`, and either
`shasum` or `sha256sum`. Go, Node.js, Foundry, and a global Solidity compiler
are not required. The localnet image builds the chain application and runs its
Go tests; the EVM client is the digest-pinned Foundry image declared in
`chain/toolchain.json` and the fixture manifest.

The command deliberately resets the localnet before running. Reset deletes all
local blocks, databases, keyring data, and signer state under the ignored
`chain/localnet/.state/container` directory. The suite stops all services on
success or failure.

## Lifecycle contract

One run performs and asserts all of the following:

1. Verifies the pinned Foundry/Solidity versions and the test fixture checksum.
2. Resets and starts the canonical four-validator network, then verifies chain
   IDs, genesis identity, quorum, validator health, block progress, four
   on-chain validator records, and exact staking/distribution/slashing
   parameters through both REST and `toriumd` CLI surfaces.
3. Derives the public disposable deployer fixture, signs a type-2 native tTOR
   transfer locally, and verifies its hash, receipt, block inclusion, replay
   domain, gas, fee, nonce, balance, finality, and matching block fingerprint
   on all validators.
4. Queries the canonical native Solidity facade for name, symbol, decimals,
   total supply, and account balance; proves those values match the native RPC
   ledger; then executes an ERC-20-style transfer and verifies the same bank
   balances, emitted event, restart/restore persistence, and zero supply drift.
5. Deploys `CompatibilityProbe`, verifies the runtime bytecode and initial
   state, then calls it and verifies the emitted event through both the receipt
   and `eth_getLogs`.
6. Broadcasts an intentionally reverting transaction and verifies receipt
   status `0x0`, gas charging, nonce consumption, and unchanged contract state.
7. Restarts every validator without resetting data. The suite waits for an
   additional block that is finalized through EVM RPC and identical on all
   four CometBFT RPCs before reading persisted state or broadcasting again.
   This bounded barrier covers the short interval in which a restarted node
   can report general health before its EVM check-state/mempool context has
   caught up.
8. Verifies bytecode, contract state, recipient balance, and signer nonce after
   restart, then submits another state transition.
9. Captures and inspects a versioned `contracts-deployed` recovery archive and
   checksums a canonical Cosmos application-state export.
10. Mutates contract state, restores the archive, and verifies exact bytecode,
   storage, balance, and nonce recovery. It then resets one validator to height
   zero and proves bounded catch-up without replacing the other three.
11. Corrupts an archive, proves restore rejects it before mutation, and emits a
    JSON lifecycle/recovery proof.

All readiness and finality waits have explicit time limits. The suite does not
use arbitrary fixed sleeps as a success condition.

## Test-only contract fixture

`contracts/CompatibilityProbe.sol` and
`fixtures/CompatibilityProbe.json` are a minimal compatibility fixture, not a
production Torium contract release. The manifest records source/compiler/tool
provenance, ABI, selectors, and bytecode, and its source checksum is checked on
every run. Production contract project structure, reproducible compilation,
artifact publication, and contract release policy remain owned by a follow-up workstream.

The signer is derived at runtime from a public, domain-separated local fixture
string. It is never printed or persisted by the suite. Local fixture keys and
the `torium-localnet-1` / `0x544f524c` replay domain must never be reused on a
valuable or public network.

## Failure diagnostics

On failure, a timestamped bundle is written under ignored
`chain/tests/e2e/.artifacts/`. It contains:

- the failing lifecycle phase and transaction hashes known at that point;
- git, Docker, Compose, Foundry, and `toriumd` versions;
- Compose status plus the last 500 validator log lines;
- health, topology, per-validator status/peer reports, and public configs;
- genesis, Solidity source, and fixture checksums needed to reproduce the run.
- ignored recovery archives/application exports created by the recovery phase.

The bundle intentionally excludes private keys, node keys, validator keys,
keyrings, databases, and signer-state files. GitHub Actions uploads the bundle
for seven days only when the E2E job fails.

For a quick syntax/fixture check without starting the network:

```bash
make -C chain/tests/e2e check
```
