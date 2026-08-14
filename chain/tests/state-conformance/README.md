# Torium EVM state conformance subset

This suite executes a small, deterministic subset of the official Ethereum
General State Tests against the exact EVM engine compiled into Torium. It does
not start validators, Docker Compose, JSON-RPC, a faucet, or a second local
network.

## What is pinned

- Source: `ethereum/tests` tag `v16.0`, commit
  `afed83bf2a097cba688a60246429f3a051fe03f6`.
- License: upstream MIT `LICENSE`, vendored as
  `LICENSE.ethereum-tests` with its Git blob and SHA-256 recorded.
- Engine: Torium's `github.com/ethereum/go-ethereum` import is required at
  runtime to resolve to `github.com/cosmos/go-ethereum@v1.17.2-cosmos-0`.
- Cosmos EVM: `github.com/cosmos/evm@v0.7.0`.
- Execution mode: hash-based trie, without snapshots.

The compiled General State Test JSON disappeared from the later `v17.2`
release tree, so this bounded suite pins the last project baseline selected for
the checked-in JSON corpus instead of downloading generated fixtures at test
time. Both Cancun and Prague post-state vectors are present. The runner also
checks that Torium's own default chain configuration activates Prague at
genesis, uses EVM chain ID `1414484556`, and uses `atorium` as the EVM/native
denomination.

Every fixture is stored byte-for-byte as its upstream Git blob. The
`manifest.json` records its upstream path, Git blob SHA-1, SHA-256, byte size,
case counts, and coverage categories. SHA-1 is used only because it is the Git
object identifier; SHA-256 is the content-integrity check.

## Coverage

The 13 fixtures total 249,968 bytes and select 64 state-test cases: 32 Cancun
and 32 Prague vectors. The subset covers:

- ADD, SSTORE, TLOAD, TSTORE, MCOPY, CREATE2, LOG0, and REVERT;
- persistent and transient state changes, rollback, memory copying, logs, and
  contract creation;
- ECRECOVER, SHA-256, RIPEMD-160, IDENTITY, MODEXP, BN256_ADD, and
  BN256_PAIRING precompiles;
- expected post-state roots, log roots, gas-sensitive inputs, and error paths.

This is intentionally a representative fast gate, not the complete upstream
corpus.

## Run

From the repository root:

```sh
make -C chain/tests/state-conformance check
make -C chain/tests/state-conformance test
```

`check` verifies the source manifest, license, fixture hashes, fixture budget,
Torium app identity, engine replacement, fork selection, case counts, and skip
registry. `test` performs those checks and then executes every selected state
transition. The JSON summary written to standard output is suitable for PR
evidence.

The suite never downloads fixtures. The repository's normal pinned Go
toolchain container and Go module cache must already be available when running
fully offline.

## Skip policy

`skips.json` is the only allowed runtime skip surface. Each entry must identify
one exact fixture/test/fork/index tuple and include:

- a stable ID;
- rationale;
- risk (`low`, `medium`, or `high`);
- owner;
- documentation link or repository path.

The runner rejects unknown fixtures, duplicate targets, stale targets, missing
metadata, and unsupported risk values. There are currently no skips; all 64
selected cases execute.

Omitting an upstream fixture from this deliberately bounded subset is a
coverage-selection decision, not a runtime skip. Adding coverage requires
checking in the exact upstream blob and extending `manifest.json` while keeping
the fixture total at or below 250,000 bytes. Anything larger belongs in the
scheduled/manual full-corpus lane.

## Boundaries

These tests exercise the real Cosmos go-ethereum state transition library that
Torium's Cosmos EVM keeper compiles and uses, and they verify Torium's app-level
EVM identity and active fork. They do not exercise:

- Cosmos SDK cache contexts, keeper persistence, ABCI, or CometBFT consensus;
- transaction admission, ante handling, fee-market accounting, or mempool
  replacement;
- JSON-RPC envelopes, receipts, block tags, WebSocket behavior, wallets, or
  Solidity toolchains;
- snapshot/path database permutations or the complete Ethereum fixture corpus;
- every Prague precompile, including KZG and P256 edge cases.

Those surfaces require the adjacent conformance lanes. This subset avoids
duplicating their live localnet startup and gives opcode/precompile regressions
a fast offline signal.
