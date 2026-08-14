# Torium EVM conformance registry

This directory is the machine-readable compatibility boundary for Torium's
standalone EVM L1. It imports every capability from the pinned Cosmos EVM
baseline in `chain/poc/upstream-baseline/support-matrix.json` and records what
wallet, explorer, operator, and future SDK consumers may claim.

The registry is not an Ethereum L2, bridge, public deployment profile, or
Torium product-backend integration. It describes local chain behavior and the
intentional differences that must remain visible to consumers.

## Files

- `evm-conformance-v1.json` contains the evidence catalog, complete capability
  import, deviations, explicit skips, and SDK behavior contract.
- `evm-conformance-v1.schema.json` defines the portable document shape.
- `upstream-baseline-lock-v1.json` preserves the exact 24 capability IDs and
  minimum states accepted by the upstream PoC, anchored to its source commit and matrix
  digest.
- `issue-107-capability-lock-v1.json` preserves all 32 capability IDs and
  minimum states ratified by registry version `1.0.0-local.3`, including the
  eight surfaces added during the conformance workstream.
- `assurance-coverage-v1.json` binds the conformance workstream to the threat-model risks,
  invariants, and release gate it partially covers without claiming that
  downstream fuzzing, SBOM, advisory, or audit work is finished.
- `validate-evm-conformance-v1.mjs` performs the cross-file semantic checks
  that JSON Schema alone cannot express.

## Validate

Run from any directory in the repository:

```bash
node chain/conformance/validate-evm-conformance-v1.mjs
```

The validator fails when:

- the support matrix contains a capability that the registry does not cover;
- the mutable extended matrix deletes or downgrades an immutable PoC-era
  capability;
- the support matrix or registry deletes or downgrades a capability ratified
  by the conformance workstream;
- either document introduces an unknown state;
- a target state is less mature than its evidence-backed baseline state;
- an upgraded state lacks rationale, owners, and evidence;
- a constrained or non-supported capability lacks a linked deviation;
- a deviation or skip lacks rationale, compatibility risk, owners, evidence,
  downstream impact, or a reciprocal capability link;
- downstream issue ownership drifts from the support matrix;
- an evidence path is missing; or
- the SDK contract permits unknown or incompatible behavior to be masked.

## Change rules

Do not edit a state merely to make a consumer test pass. Update or add the
local proof first, record its evidence ID, add `stateChange` metadata, and then
change the target state. A `partial`, `stub`, or `unsupported` state must remain
visible as capability detection, an explicit rejection, or a documented
non-applicable surface.

The PoC support matrix remains historical evidence for its exact noncanonical
PoC identifiers. Canonical Torium identifiers come from
`chain/config/protocol-v1.json`; this registry never promotes the PoC chain ID
to a Torium network.

The conformance workstream extends that matrix with canonical localnet evidence when a new
compatibility surface is discovered. The first such extension records that
OpenZeppelin contract execution works, while `eth_estimateGas` materially
underestimates the tested ERC-20 state write. SDKs must expose both the raw
estimate and any configured submission margin until that capability is
re-proven as exact.

Endpoint compatibility is profile-specific. The canonical local profile proves
ordinary subscriptions and reconnect/backfill, rejects URL-form browser
Origins, and keeps `debug_*` unavailable. The engine-level trace capability is
preserved from the PoC, but explorer/operator success envelopes remain an explicit
archive/role-topology follow-up instead of being inferred from the EVM chain ID.

The canonical fee and transaction proof accepts standard type 0, 1, and 2
envelopes, rejects both a transaction signed for another EIP-155 domain and an
unprotected legacy signature, and verifies the configured fee-history,
replacement, nonce-gap, block-gas, and accounting boundaries. Receiving-node
replacement and the non-geth 100-block fee-history limit remain explicit SDK
capabilities rather than being normalized away.

Blob type 3 and set-code type 4 are explicit unsupported capabilities. A raw
RPC hash is only an asynchronous acknowledgement: the canonical proof verifies
that neither unsupported envelope is retained or proposed, while the app ante
tests lock fail-closed protocol rejection. Historical `eth_call` and debug
support are similarly profile-specific machine capabilities, not generic
Ethereum-compatibility booleans.
