# Change: Machine-readable EVM conformance registry

## Summary

Added a versioned compatibility registry for the Torium standalone EVM L1.
The registry consumes all 32 capability records from the extended upstream
Cosmos EVM support matrix and turns their supported, partial, stub, and
unsupported states into an enforceable contract for later chain tests and SDK
work.

## Files and surfaces changed

- `chain/conformance/evm-conformance-v1.json`
  - imports every baseline capability and its downstream owner;
  - catalogs the committed proof artifacts used by those claims;
  - records 14 intentional compatibility deviations and six explicit skips;
  - defines the behavior future SDK consumers must use for each capability.
- `chain/conformance/evm-conformance-v1.schema.json`
  - defines the registry, capability, evidence, deviation, skip, and SDK
    contract shapes.
- `chain/conformance/validate-evm-conformance-v1.mjs`
  - cross-checks the registry against the source support matrix and evidence
    files.
- `chain/conformance/README.md`
  - documents validation and evidence-backed state-change rules.

## Behavior

Validation rejects incomplete capability coverage, unknown states, silent
state regressions, unsupported behavior marked as standard SDK behavior,
unexplained source constraints, missing evidence, stale downstream ownership,
and one-way deviation or skip references. A future improvement from one state
to a more mature state is allowed only with explicit rationale, owners, and
evidence.

The current registry deliberately preserves the baseline observations instead
of upgrading claims before the canonical live suites exist. In particular,
method-specific block tags, CometBFT finality semantics, browser WebSocket
origin behavior, client-owned reconnect/backfill, local-only fee replacement,
mempool eviction, Blockscout trace-envelope incompatibility, the undefined
Cosmos extension contract, and the bridge/IBC exclusion remain visible.

The canonical tooling proof also records a contract gas-estimation
difference: an unmodified OpenZeppelin ERC-20 transfer estimated `22,430` gas,
reverted at that exact limit, and succeeded with a `250,000` submitted limit
while consuming `125,000`. viem, ethers, Hardhat, Foundry, ERC-20, and ERC-721
otherwise completed against the canonical four-validator localnet. Future SDK
work must expose the raw estimate and its configurable margin rather than
presenting the estimate as guaranteed execution gas.

The offline state lane pins 13 upstream `ethereum/tests` v16.0 fixtures by Git
blob and SHA-256 and executes 64 Cancun/Prague subtests against Torium's exact
`github.com/cosmos/go-ethereum@v1.17.2-cosmos-0` replacement. All 64 pass with
zero runtime skips; the bounded subset covers state roots, log roots, rollback,
transient state, creation, core opcodes, and representative precompiles without
booting a second localnet.

The canonical RPC lane proves the block-tag matrix per method, standard
JSON-RPC error codes, the 100/101 batch boundary, `newHeads`, `logs`, and
`newPendingTransactions`, plus socket restart, HTTP backfill, and resubscribe.
URL-form browser origins return HTTP 403 in the default profile. Debug methods
remain engine-supported by the baseline proof but return `-32601` on the
default Torium endpoint; a separately limited operator profile remains owned
by the explorer and endpoint-profile tracks and is recorded as an explicit
skip.

The canonical fee lane proves EIP-155 protected type 0, EIP-2930 type 1, and
EIP-1559 type 2 transactions. It also rejects a type-0 transaction signed for
chain ID `1414484557` while Torium expects `1414484556`, rejects an unprotected
Homestead-style signature, and leaves the canonical nonce unchanged. The same
suite verifies the 100/101 `eth_feeHistory` boundary against a fully saturated
30,000,000-gas block, exact receiving-node 10% fee replacement, nonce-gap
commit order, configured capacity evidence, oversize rejection, base-fee
movement, receipt accounting, and unchanged native supply.

Blob type 3 is rejected immediately, while a syntactically valid set-code type
4 can receive an asynchronous RPC acknowledgement but is neither retained nor
proposed. The Torium ante policy rejects both types before ordinary EVM
handling, and unit coverage locks that rule. SDKs must reject type 3 and type 4
locally rather than translate them or treat an RPC hash as retention.

The RPC lane now also proves historical state execution: after a contract value
changes from `0` to `96`, `eth_call` at the explicit pre-mutation height still
returns `0` while `latest` returns `96`. Debug support is split into three
machine-readable capabilities: engine support, unsupported default-profile
methods, and a still-undefined operator profile.

The immutable baseline lock preserves its original 24 capability IDs and
minimum states so simultaneous edits to the extended matrix and registry cannot
hide a regression. A second canonical-suite lock preserves all 32 IDs and
minimum states ratified by registry version `1.0.0-local.3`, including the
eight capabilities added by the canonical suites. The canonical assurance
binding marks T003/INV001, T013/INV012, T015/INV014, T021/INV020, and release
gate G03 as only partially covered; the remaining system-contract fuzzing,
dependency/SBOM, release CI, and audit work stays assigned to its downstream
tracks.

The canonical headed MetaMask lane reached Torium Localnet selection, account
connection, loopback faucet funding, and the transaction confirmation screen.
MetaMask 13.39.2 then required its localized fee-warning review modal before
signing. After repeated headed attempts, the canonical slice preserves the
successful pinned baseline wallet proof and records completion of the canonical
signed-transfer screenshot as an explicit wallet-conformance follow-up instead
of spending additional local or CI runs on UI-selector iteration.

## Why

JSON-RPC libraries can make a chain appear Ethereum-compatible while quietly
hiding unsupported methods or changing semantics. The registry gives the
chain tests, documentation, and future SDK a single evidence-backed input: an
unknown capability is rejected, and a non-supported capability must be
surfaced or the operation must be rejected.

## Verification

```bash
node chain/conformance/validate-evm-conformance-v1.mjs
```

The validator is local-only and does not start nodes, call the Torium backend,
deploy infrastructure, or contact a public network.

## Follow-ups

- The canonical suites add live and state-fixture evidence without weakening
  these deviation rules.
- The explorer track owns the internal-transaction adapter decision.
- The endpoint-profile track owns browser WebSocket and endpoint-origin
  profiles.
- The SDK track consumes the registry when defining public SDK and Cosmos
  extension APIs.
- The wallet-conformance track consumes the mempool and transaction-lifecycle
  capabilities and completes the canonical MetaMask signed-transfer proof.

## Rebase reconciliation (2026-07-27)

Rebasing onto the roadmap tip surfaced downstream contracts that pin the RPC
profile this slice bumps to `1.0.1` (adding the locally proven
`newPendingTransactions` WebSocket subscription). The pinned references were
updated in the same slice so every fail-closed validator stays green:

- `chain/performance/performance-v0.json` `sources.rpcProfile.version`
- `chain/observability/observability-v0.json` `rpcProfile.profileVersion`
- `chain/profiles/node-roles-v0.json` `currentLocalRpcProfile.profileVersion`
- `chain/explorer/selection-v1.json` (+ its validator's expected list):
  refreshed SHA-256 for `chain/config/rpc-profile-v1.json` and the updated
  `chain/poc/upstream-baseline/support-matrix.json` evidence
- `chain/releases/network-artifacts-v0.json` + `SHA256SUMS`: regenerated
  because the explorer-selection and node-roles source bytes changed

The SDK surface was synchronized in the same slice: `toriumLocalnet` chain
metadata and `toriumReadCapabilities` now report the `1.0.1` RPC profile with
`newPendingTransactions` in the active local WebSocket profile, and the SDK
declaration/package snapshots plus the generated docs reference were
regenerated accordingly.

The labeled chain-acceptance run on 2026-07-27 passed the four-validator,
fee, RPC, and faucet suites, then failed in the governance-upgrade suite with
"No space left on device" on the hosted runner. The workflow now frees
preinstalled toolchains up front and prunes the Docker build cache before the
upgrade suite; the suites themselves were not changed.

A second labeled run passed the first four suites with the disk fix but hit
the 60-minute job timeout inside the governance-upgrade suite (five suites
now rebuild pinned containers in one job). The acceptance job timeout was
raised to 90 minutes.

Final acceptance evidence (2026-07-27): all five clean-checkout suites — the
four-validator E2E, fee/anti-spam, endpoint, faucet, and governance/upgrade
acceptance (upgrade passed at height 95) — ran green locally on this branch
head per the decision to stop repeating the hour-long run in hosted CI. The
final rebase onto the roadmap tip changed no chain content covered by those
suites (chain/app, genesis, config, localnet, conformance, contracts, and
operator trees are byte-identical; chain/tests only gained the tooling
conformance suite), so the evidence carries to the merged commit.
