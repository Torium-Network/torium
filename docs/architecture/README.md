# Torium EVM architecture index

This index covers the standalone Torium sovereign EVM L1, SDK and developer
documentation workstream.

## Normative contracts

1. [Protocol and network specification v1](./torium-evm-l1-protocol-v1.md) —
   network identifiers, accounts, native asset, consensus/finality semantics,
   limits, transaction envelopes, modules, precompiles, endpoints and breaking
   change rules.
2. [`chain/config/protocol-v1.json`](../../chain/config/protocol-v1.json) —
   machine-readable source for protocol constants.
3. [`chain/config/trust-model-v1.json`](../../chain/config/trust-model-v1.json)
   — machine-readable source for validator authority and fault expectations.
4. [`chain/config/identifiers.json`](../../chain/config/identifiers.json) —
   canonical chain, currency, address-prefix, package and docs identifiers.
5. [`chain/poc/upstream-baseline/support-matrix.json`](../../chain/poc/upstream-baseline/support-matrix.json)
   — tested compatibility ceiling for the exact upstream baseline.
6. [Chain threat model v1](../security/torium-chain-threat-model-v1.md) —
   assets, actors, boundaries, high/critical risks, security invariants,
   secret policy, residual risk, review triggers, and public-release gates.
7. [`chain/security/threat-model-v1.json`](../../chain/security/threat-model-v1.json)
   — machine-readable security register and executable test ownership map.
8. [`chain/app/README.md`](../../chain/app/README.md) — standalone `toriumd`
   composition, deterministic build commands, container, and contract tests.
9. [Local accounts, keyrings, and faucet](../../chain/localnet/ACCOUNTS.md) —
   valueless funding, dual address forms, secret boundaries, and CLI flows.
10. [Validator lifecycle operator guide](../../chain/operator/VALIDATOR_LIFECYCLE.md)
    — local-only admission, delegation, rewards, unbonding, jailing,
    tombstoning, query surfaces and consensus-key safety.
11. [`chain/config/governance-v1.json`](../../chain/config/governance-v1.json)
    — local governance parameters, module authorities, upgrade plan, binary
    profiles, failure/recovery contract, and public activation boundary.
12. [`chain/config/sdk-policy-v0.json`](../../chain/config/sdk-policy-v0.json)
    — SDK module, runtime, account, compatibility, versioning, and
    bundle-budget contract.
13. [Attestation canonical hashing v1](./torium-attestation-canonical-hashing-v1.md)
    — exact-byte hashing, ABI commitment order, identifier domain, privacy
    limits and public non-claims.
14. [`chain/profiles/node-roles-v0.json`](../../chain/profiles/node-roles-v0.json)
    — offline-validated local validator, sentry, full/query, public RPC, and
    archive/indexer planning contract; see the
    [offline validator](../../chain/profiles/validate-node-roles-v0.mjs).
15. [Node-role topology and startup runbook](../operations/torium-node-role-topology-runbook.md)
    — validator, sentry, full/query, public RPC, archive/indexer, startup,
    failure, history, capacity, and HOLD boundaries. The archive/indexer role
    is activated locally by `torium-localnet --archive` plus
    [`chain/profiles/compose.archive-gateway.yaml`](../../chain/profiles/compose.archive-gateway.yaml),
    behind the `torium-archive-gateway` enforcement sidecar.
16. [`chain/explorer/stack-v0.json`](../../chain/explorer/stack-v0.json) —
    local-only inventory for the complete explorer data plane, dependency
    pins, private archive gateway, readiness, and recovery gates.
17. [`chain/observability/observability-v0.json`](../../chain/observability/observability-v0.json)
    — local metrics, logs, alerts, dashboard and tracing boundary; see the
    [observability runbook](../operations/torium-chain-observability-runbook.md).
18. [`chain/recovery/recovery-v0.json`](../../chain/recovery/recovery-v0.json)
    — operator pruning, state-sync, snapshot, backup, retention and restore
    contract.
19. [`chain/security/key-custody-v0.json`](../../chain/security/key-custody-v0.json)
    — key inventory, offline signer-state guard, lifecycle HOLDs, and
    compromise ownership; see the
    [key lifecycle runbook](../operations/torium-validator-signer-lifecycle.md).
20. [`chain/performance/performance-v0.json`](../../chain/performance/performance-v0.json)
    — local workload and result contract with no runtime capacity claim.
21. [`chain/resilience/resilience-plan-v0.json`](../../chain/resilience/resilience-plan-v0.json)
    — local finality/recovery scenario and report contract.
22. [`chain/releases/network-artifacts-v0.json`](../../chain/releases/network-artifacts-v0.json)
    — generated localnet genesis, wallet and compatibility metadata.
23. [EVM conformance registry](../changes/2026-07-15-evm-conformance-registry.md)
    — versioned, evidence-backed capability contract consumed by the chain
    tests, documentation, and SDK.

## Boundaries

- [Repository path and generated-artifact map](../../chain/REPOSITORY_MAP.md)

## Validation

Run these before changing any protocol value:

```bash
node chain/config/validate-identifiers.mjs
node chain/config/validate-protocol-v1.mjs
node chain/config/validate-trust-model-v1.mjs
node chain/config/validate-rpc-profile-v1.mjs
node chain/config/validate-faucet-policy-v1.mjs
node chain/config/validate-public-faucet-service-v0.mjs
node chain/config/validate-governance-v1.mjs
node chain/config/validate-sdk-policy-v0.mjs
node chain/explorer/validate-selection-v1.mjs
node chain/explorer/validate-stack-v0.mjs
node chain/observability/validate-observability-v0.mjs
node --test chain/observability/health-exporter.test.mjs
node chain/profiles/validate-node-roles-v0.mjs
node chain/recovery/validate-recovery-v0.mjs
node chain/security/validate-threat-model-v1.mjs
node chain/security/validate-key-custody-v0.mjs
node --test chain/operator/signer-state-guard.test.mjs
node chain/performance/validate-performance-v0.mjs
node --test chain/performance/summarize-samples.test.mjs
node chain/resilience/validate-resilience-plan-v0.mjs --committed-results
node --test chain/resilience/validate-resilience-result-v0.test.mjs
node chain/releases/generate-network-artifacts-v0.mjs --check
node chain/releases/validate-release-pipeline-v0.mjs
node chain/scripts/scan-prohibited-secrets.mjs --self-test
```

The prose explains why values exist; the JSON manifests and executable
assertions prevent the prose, node implementation, SDK and docs from silently
forking them.
