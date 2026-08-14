# Torium chain threat model v1

Status: local-development security contract (`1.0.0-local.5`), accepted
2026-07-15.

This model covers the standalone sovereign Torium EVM L1, generic system
contracts, public RPC shape, operator and recovery workflows, local/public-
testnet-shaped faucet, release artifacts, TypeScript SDK, and developer docs.
It does not cover or authorize the existing Torium backend/mobile product,
bridges, IBC runtime, Ethereum L2 settlement, TGE, live-value migration,
infrastructure purchase, public deployment, or mainnet launch.

The normative register is
[`chain/security/threat-model-v1.json`](../../chain/security/threat-model-v1.json).
Executable validation is in
[`chain/security/validate-threat-model-v1.mjs`](../../chain/security/validate-threat-model-v1.mjs).
This document explains the model; it does not replace the machine contract.

## Security posture

Torium currently authorizes only a valueless, local, authority-operated chain.
The four local validator processes share one administrative trust domain. A
local operator can censor, halt, reset, replace binaries, and replace the local
history presented to clients. This is useful for deterministic consensus and
fault testing but is not decentralization, public economic security, or a
production control plane.

Every registered risk is high or critical because this roadmap is establishing
the consensus, key, supply, contract, endpoint, release, and recovery roots that
later work will depend on. “Designed” is not “mitigated”: public release remains
blocked until the owner issues implement and exercise the mapped tests.

## Scoring and acceptance

Risk score is likelihood (1–5) multiplied by impact (1–5):

| Score | Severity |
| ----: | -------- |
| 20–25 | critical |
| 12–19 | high     |
|  6–11 | medium   |
|   1–5 | low      |

Impact 5 means consensus safety, supply, privileged key, or trusted-release
compromise. High and critical risks require prevention, detection, recovery,
owners, stable test IDs, review triggers, an explicit residual risk, and a
blocking public-release gate. No risk is automatically accepted. Documented
residual risk may be exercised only on valueless local infrastructure; the external security review
owns any later public risk-acceptance decision.

## Assets and actors

The register protects 14 asset groups:

- validator consensus/signer state and privileged operator/governance keys;
- genesis, chain IDs, checksums, application state, native balances, staking
  power, fees, rewards, and evidence;
- modules, precompiles, system contracts, deployment registry, ABI, bytecode,
  and events;
- P2P/RPC/WebSocket/REST/gRPC, faucet, explorer/indexer, snapshots/state sync,
  backups, metrics, logs, screenshots, and support bundles;
- source, dependencies, CI, binaries, images, checksums, SBOMs, provenance,
  SDK metadata, transports, examples, and docs.

Actors include the current local authority, future independent validators,
ordinary untrusted users, malicious validator coalitions, external network
attackers, compromised hosts/operators, supply-chain attackers, faucet/RPC
abusers, malicious contract callers, privileged maintainers, and derived-data
operators. A validator, explorer, snapshot, RPC, or release role is trusted
only for the minimum surface documented by its boundary; one role is never
implicit authority over another.

## Trust boundaries

| ID  | Boundary                              | Main controls / owner                                                                                   |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| B01 | client → public RPC                   | chain/genesis validation, TLS when public, method/body/batch/time/origin/rate caps |
| B02 | internet/sentry → validator P2P       | hidden validators, diverse bounded peers, eclipse monitoring |
| B03 | validator node → signer               | separate custody, one active signer, monotonic last-sign state |
| B04 | CometBFT → Cosmos app                 | deterministic ABCI, proposal validation, equal app hashes |
| B05 | EVM → Cosmos module/precompile        | explicit composition, normal authorization, atomic revert, fuzzing |
| B06 | governance → privileged state/upgrade | named authority, versioned plan/handler, simulation/rehearsal |
| B07 | source/dependency → artifact          | immutable pins, clean builders, review, checksum/SBOM/signature/provenance |
| B08 | snapshot/state sync → node state      | genesis + trusted height/hash, checksums, independent verification |
| B09 | canonical chain → explorer/indexer    | finalized cursor, reset/reorg detection, reconciliation/backfill |
| B10 | faucet request → signer/RPC           | isolated capped signer, idempotency, budgets, layered limits, bounded queue |
| B11 | standalone chain → Torium product     | no imports/auth/database/shared secrets; optional future adapter only |
| B12 | operator state → diagnostics          | allowlisted redaction, binary/text scan, staging gate, access/retention |

## Critical risks

| ID   | Risk                                                                            | Current state / owners                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T001 | validator key theft, cloning, signer rollback, or double-sign                   | custody and recovery tests pending |
| T003 | nondeterministic app/EVM/precompile/module execution                            | exact baseline pinned; composition, differential, and app-hash tests pending |
| T005 | unauthorized governance, parameter, privileged action, or upgrade               | local authority, named handler, failed-migration rollback and four-validator rehearsal implemented; public authority remains blocked |
| T006 | source/dependency/builder/artifact/image/provenance compromise                  | immutable toolchain exists; reproducible signed release pipeline pending |
| T015 | system-contract or precompile authorization/reentrancy/accounting/event failure | v0 contract controls, fuzz/invariants and static gates exist; precompile differential and external review remain pending |
| T021 | known/novel upstream vulnerability or abandoned maintenance line                | baseline reviewed; continuous advisory/SBOM/conformance/audit work pending |

A critical failure causes safe halt and evidence preservation first. Manual
database edits, hidden patches, silently replaced genesis, or an unreviewed
binary are not recovery mechanisms.

## High risks

| ID   | Surface                                   | Required outcome                                                                                                                                             |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T002 | malicious validators/partitions           | power/failure-domain controls and all resilience quorum scenarios                                                                                                  |
| T004 | genesis/supply/denom/power/IDs            | deterministic generation, post-genesis mint denial, conservation, checksum, and new IDs after abandoned public genesis                                       |
| T007 | secret leakage                            | six-surface redacted scanner, CI enforcement, rotation and artifact revocation                                                                               |
| T008 | snapshots/state sync/backups              | authenticated trust anchors, checksum/app-hash verification, recovery drills                                                                                 |
| T009 | transaction replay/wrong network          | both chain IDs, sequences, reset cleanup, public replay-domain replacement                                                                                   |
| T010 | RPC/debug/log/trace/subscription DoS      | role contract and local limits defined; effective exposure, load, telemetry, shedding, and public hardening remain pending                                   |
| T011 | P2P eclipse/address exposure              | sentry topology contract defined; local isolation, peer diversity, partition tests, and safe catch-up remain pending                                         |
| T012 | faucet abuse/signer compromise            | capped isolated hot wallet, idempotency/budgets/queues, pause/rotation/reconciliation                                                                        |
| T013 | nonce/mempool/replacement/lifecycle       | local receiving-node 10% fee-cap/tip-cap replacement is tested; client lifecycle and public evidence remain pending                                          |
| T014 | stale/spoofed/incomplete explorer         | local Blockscout candidate selected; canonical reconciliation, lag/reset markers, recovery proof, and public gates remain pending                            |
| T016 | registry/ABI/address/bytecode tamper      | deterministic deployment and runtime-code/checksum verification                                                                                              |
| T017 | fees/gas/payload/state-growth spam        | local fee/resource limits, payload rejection, 25.021M-gas saturation and base-fee response are tested; public capacity/state-growth evidence remains pending |
| T018 | 18-decimal precision/accounting           | bank/EVM/Solidity conservation plus local stake/share/power/reward/commission/slash/dust/fee invariants; public review remains gated                         |
| T019 | key/node backup rollback                  | monotonic signer recovery, evidence retention and exercised runbooks                                                                                         |
| T020 | host/container/profile compromise         | least-privilege role contract defined; runtime segmentation, hardening, detection, and clean rebuild remain pending                                          |
| T022 | endpoint spoof/RPC semantic mismatch      | no invented fallback, chain/genesis handshake, capabilities and TLS                                                                                          |
| T023 | log/screenshot/support-bundle leak        | allowlisted diagnostics, extracted-staging scan, retention and rotation                                                                                      |
| T024 | CI/branch/tag/reviewer/cache bypass       | protected reviews, least-privilege credentials, clean rebuild and provenance                                                                                 |
| T025 | reward/attestation/proof/role/event spoof | reward and permissionless-attestation controls are tested; external review and SDK state/event reconciliation remain pending                                 |

The exact prevention, detection, recovery, owner, residual-risk, and trigger
arrays for every row live in the machine register and are validation-enforced.

## Executable security invariants

Twenty invariants map all 25 risks to 59 stable test IDs. The four required
evidence families are:

- **fuzz:** state determinism, request bounds, faucet replay/limits, contract
  call sequences, resource accounting, and 18-decimal conservation;
- **integration:** genesis, app hash, upgrades, artifacts, replay domains,
  profiles, lifecycle, registry, recovery, hardening, and SBOM/advisories;
- **chaos:** all 11 IDs from the validator trust model, RPC/explorer failure,
  overload, restart, partitions, clock/network delay, set change, equivocation,
  and proposer censorship;
- **runbook:** upgrade interruption, artifact/key/secret compromise, corrupt
  state, eclipse recovery, faucet signer compromise, support bundles, and
  critical advisories.

`validate-threat-model-v1.mjs` fails if a high/critical risk is unmapped, an ID
is duplicated, an owner is missing, severity does not match its score, or any
trust-model chaos ID lacks a security invariant.

The currently executable fee-policy evidence is deliberately local: it proves fee
accounting without supply change, a 1 gwei floor, underpriced non-retention,
receiving-node-only replacement, encoded-payload rejection and recovery, a
25,021,000-gas block under the 30M limit, and a next-block base-fee increase.
It does not bound sustained state growth or establish public capacity. Those
claims remain blocked on tracked follow-up work and the launch-activation gate.

## Secret and diagnostic policy

[`secret-policy.json`](../../chain/security/secret-policy.json) and
[`scan-prohibited-secrets.mjs`](../../chain/scripts/scan-prohibited-secrets.mjs)
cover tracked chain source plus explicit artifact paths. The self-test injects
synthetic credentials in memory for all six surfaces:

1. tracked source;
2. logs;
3. binary images and metadata;
4. support-bundle staging;
5. fixtures;
6. examples.

The scanner never includes a matched value in output. It fails closed for key
files, runtime environment files, symlinks, oversized files, and archives. A
compressed support bundle is not scanned in place: scan the exact extracted or
generated staging directory before packaging. Binary buffers are inspected so
ASCII secrets in image metadata remain visible.

Known-valueless findings are suppressed only through the `allowlist` section
of `secret-policy.json`. Every entry names one exact path, the exact
content rules and finding counts it covers, a substantive justification, and
an owning issue. Enforcement is fail-closed in both directions: a finding
outside the allowlist fails, and an allowlist entry whose in-scope path no
longer produces exactly the declared findings fails as
`allowlist-entry-stale`. File-policy findings (forbidden filenames or
extensions, runtime environment files, archives, symlinks, oversized files)
can never be allowlisted. The current entries cover the committed
ethereum/tests-derived state-conformance fixture keys and audited
false positives in crypto API call sites and redaction tests. The
repository-wide scan runs in CI via
`.github/workflows/chain-secret-scan.yml` (gate `repository-secret-scan` in
`chain/ci/ci-gates-v0.json`).

Default tracked scope follows the standalone-chain boundary: `chain`,
`contracts`, `packages/torium-sdk`, `apps/developer-docs`, `examples/torium`,
`infra/torium`, repository docs/workflows, and root package metadata. Legacy
Torium product apps/backend/infra are explicitly outside this chain policy and
must retain their own security controls; chain work may not import their
credentials.

Pattern scanning cannot prove absence of encoded, fragmented, encrypted,
novel, memory-only, or visual-only secrets. Support-bundle allowlisting,
least-privilege CI, manual review, short retention, and immediate revocation on
any finding remain mandatory.

## Public-release gates

Public release is blocked until all ten gates pass:

1. every high/critical risk remains fully owned and evidence-backed;
2. all source/artifact/support secret gates pass;
3. deterministic genesis/app/EVM/module/precompile/economic tests pass;
4. every trust-model chaos scenario passes with no conflicting commit under
   tolerated faults;
5. system-contract fuzz/invariant/access/registry/audit gates pass;
6. snapshot/state-sync/backup/key/upgrade recovery runbooks pass;
7. reproducible signed artifacts, SBOM, provenance, branch protection, and a
   second security reviewer exist;
8. public faucet isolation, budget, abuse, monitoring, and emergency tests pass;
9. external audit/launch review has no unresolved high/critical finding;
10. the owner grants explicit current deployment approval after prerequisites.

Completing this threat model does not complete those downstream mitigations and
does not authorize a public endpoint or deployment.

## Review triggers

Re-review on any protocol/module/precompile/fee/mempool/finality change; key,
validator, governance, upgrade, snapshot, RPC/P2P, faucet, explorer, contract,
CI/release or support-bundle change; new operator/provider/environment; security
advisory or incident; app-hash/supply/checksum mismatch; or proposal to add the
Torium product backend, PoP consensus influence, IBC, a bridge, L2, live value,
or mainnet behavior.
