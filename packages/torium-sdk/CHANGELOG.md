# Changelog

## 0.1.1 — 2026-08-14

Re-release of 0.1.0 from the public repository with a provenance attestation
that references the published source history. No functional changes.

## 0.1.0 — 2026-08-14

- Added the private package foundation, dual ESM/CommonJS output, declarations,
  export map, clean-fixture validation, API report, and package-content drift
  guard.
- Added canonical localnet, devnet, testnet, and mainnet chain definitions,
  immutable caller-owned RPC URL overrides, and fail-closed endpoint identity
  and readiness validation.
- Added the viem-compatible public client extension, bigint-safe read-only
  network status, canonical capability/deviation metadata, safe block-tag
  guidance, and deterministic fee-history/log-range guards.
- Added a stable SDK error taxonomy and normalizer, redacted causes, typed
  endpoint error compatibility, opt-in allowlisted diagnostics, cancellation,
  per-action timeouts, bounded explicit retries for idempotent reads, and
  exactly-once broadcast execution.
- Added the wallet transaction foundation: EIP-1559 preflight with structured
  blockers, authorize-before-sign, exactly-once submission acknowledgement,
  and CometBFT commit/revert/timeout lifecycle classification.
- Added the `./contracts` surface: generated ABIs and the localnet deployment
  registry, fail-closed deployment resolution with local overrides, runtime
  bytecode verification, Merkle-sum reward helpers and claim preflight,
  attestation canonical-hash helpers and preflights, and prepare/simulate
  steps composing with the wallet lifecycle.
- Validated the packed tarball against the live four-validator localnet
  (22-capability conformance matrix) and accepted the node's bare JSON-number
  `net_peerCount` alongside spec hex quantities.
- Added release readiness: a machine-readable publish policy, dry-run tarball
  reproduction checks, and a release checklist. The package remains
  unpublished; publishing requires explicit approval.
- Compatibility: chain manifest `0.2.0`, contracts registry `0.1.0`
  (localnet, no broadcast addresses), viem `>=2.55.2 <3` (`2.55.2` tested),
  developer docs `v0`.
- Cosmos-native extension queries, reconnect/backfill subscription lifecycle,
  and public-network activation remain follow-up work.
