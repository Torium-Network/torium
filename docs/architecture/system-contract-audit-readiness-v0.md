# Torium system-contract audit-readiness package v0

Status: audit-readiness reference for the launch security review. This document is an
inventory and review procedure, not an audit report, deployment approval or
claim that the contracts are secure.

No external auditor has reviewed this package. No Torium-authored Solidity
contract in this package has been deployed to a public Torium network. The
reward and attestation registry entries are addressless plans, and the CREATE2
factory address is an unbroadcast local prediction. Do not describe this work
as “audited”, “externally reviewed”, “production ready” or “live”.

## Exact v0 scope

The release candidate handed to a reviewer must be a clean, immutable commit.
The commit and bundle checksum are intentionally `TBD` until The launch security review consumes a
clean candidate; a working tree, branch name or generated artifact by itself is
not a review identity.

### Solidity review scope

| Surface               | In-scope files                                             | Review boundary                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native TOR facade     | `contracts/src/interfaces/IToriumNative.sol`               | ABI and single-ledger integration assumptions only. The Cosmos EVM precompile implementation and `x/bank` accounting live in the chain review, not this Solidity review. |
| Deterministic factory | `contracts/src/deployment/ToriumCreate2Factory.sol`        | Permissionless CREATE2 address derivation, value handling and exact runtime-code-hash enforcement.                                                                       |
| Reward distributor    | `contracts/src/rewards/ToriumRewardDistributor.sol`        | Native funding, Merkle-sum proofs, accounting, claims, expiry clawback, pause behavior and inherited access administration.                                              |
| Attestation registry  | `contracts/src/attestations/ToriumAttestationRegistry.sol` | Issuer authentication, deterministic commitments and IDs, replay protection, supersession, revocation, status and state growth.                                          |

The OpenZeppelin `5.6.1` integration is in scope. Reviewers must check how
`AccessControlDefaultAdminRules`, `Pausable`, `ReentrancyGuard` and `Create2`
are used. Re-auditing every upstream library implementation is not implied.
The bundle records the exact registry URL and integrity pin; reviewers must
materialize and inspect that source when checking the inherited ABI, license
and applicable advisories.

### Evidence and configuration scope

The handoff includes:

- `contracts/foundry.toml`, `contracts/package.json`,
  `contracts/package-lock.json`, `chain/toolchain.json`, remappings and the
  `.github/workflows/torium-sdk.yml` CI entrypoint;
- all files under `contracts/test/`, the reward and attestation fixtures, and
  both committed files under `contracts/gas-snapshots/`;
- `contracts/config/components-v1.json`, the deployment-registry schema,
  `contracts/deployments/localnet.json`, `contracts/deployments/SHA256SUMS` and
  generated ABIs;
- the generator, fixture validators, registry validator and local acceptance
  tooling as evidence-producing support code; and
- the [contract deployment boundary](../decisions/2026-07-16-contract-deployment-boundary.md),
  [reward design](../decisions/2026-07-16-merkle-sum-reward-distributor.md),
  [attestation design](../decisions/2026-07-16-permissionless-attestation-registry.md),
  [canonical hashing rules](./torium-attestation-canonical-hashing-v1.md) and
  [chain threat model](../security/torium-chain-threat-model-v1.md).

Before handoff, record the clean commit, Solidity/Foundry/OpenZeppelin versions,
compiler settings, dependency-lock checksum, registry checksum, generated
artifact checksums, test/coverage/gas commands, exclusions and known findings
in one immutable bundle manifest. the launch security review must record the final bundle checksum;
this v0 prose is not that manifest.

The bundle normalizes coverage to covered/total counts and percentages. Raw
Forge output and volatile durations are deliberately excluded from its primary
scope digest.

The current reproducibility baseline is already machine-pinned:

| Input                    | Current value                                                                                                   | Source of truth                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Solidity                 | `0.8.30` (`0.8.30+commit.73712a01`)                                                                             | `chain/toolchain.json` and `contracts/foundry.toml`      |
| Foundry                  | `1.7.1`, digest-pinned image                                                                                    | `chain/toolchain.json`                                   |
| OpenZeppelin Contracts   | `5.6.1`                                                                                                         | `chain/toolchain.json` and `contracts/package-lock.json` |
| EVM/compiler profile     | Prague; optimizer enabled with 200 runs; `via_ir = false`; bytecode metadata disabled                           | `contracts/foundry.toml`                                 |
| Fuzz/invariant profile   | 256 fuzz runs; reward invariants 256×500; bounded attestation lifecycle invariant 128×64; fixed replayable seed | `contracts/foundry.toml` and test inline config          |
| Solidity analysis        | Forge lint plus Solhint `5.0.5`                                                                                 | `chain/toolchain.json` and contract package lock         |
| Fixture/registry runtime | Node `22.23.1` and Ajv `8.17.1`                                                                                 | `chain/toolchain.json` and contract package lock         |

The digest and lockfile are authoritative; copying this table into another
branch does not pin that branch. Any change to one value creates a new bundle
identity and requires affected evidence to be regenerated.

### Explicit exclusions

- Torium backend, database, product authentication, mobile/web applications and
  any future adapter between those systems and this standalone L1;
- bridge, IBC runtime, Ethereum L2 settlement, TGE, token migration and any
  live-value or public-network deployment;
- Cosmos SDK, Cosmos EVM, CometBFT, validator, governance, RPC, faucet,
  explorer, infrastructure and release-pipeline internals except where their
  assumptions cross the listed contract interfaces;
- business truth of reward allocations, legal identity or truth of an
  attestation, off-chain content availability and privacy of unhashed source
  material; and
- production signer custody, multisig vendors, organization-specific role
  holders, public constructor values and incident contacts, none of which are
  selected yet.

An excluded system is not assumed safe. A finding that crosses a boundary must
be linked to its owning issue and included in the launch security review.

## Role and irreversible-action matrix

All reward role assignments and constructor values are currently unassigned.
“Multisig compatible” below means an address-capable contract wallet can call
the function; no concrete multisig integration or recovery rehearsal has
occurred.

| Component / authority                   | Allowed action                                                                                  | Delay or limit                                                                                                      | Loss or compromise impact                                                                        | Required deployment boundary                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Native TOR protocol authority           | Change precompile behavior only through a reviewed chain upgrade                                | Protocol governance/upgrade rules, outside Solidity                                                                 | Supply, accounting or ABI failure can affect the chain                                           | Review under protocol and the launch security review; never model as a Solidity owner                                   |
| Factory caller (any address)            | Deploy supplied init code/value at its CREATE2 address                                          | Exact init-code-derived address and expected runtime hash; no admin or pause                                        | A caller cannot take a role, but immutable bad code can still be deployed at a requested address | Treat every init code, salt, value and runtime hash as deployment inputs                          |
| Reward `DEFAULT_ADMIN_ROLE`             | Grant/revoke operational roles; use inherited delayed default-admin transfer and delay controls | Default-admin transfer is delayed; ordinary operational role changes are not separately timelocked by this contract | Can replace publisher, pauser or clawback operator; loss can block recovery                      | Distinct durable multisig-shaped holder; nonzero delay; document transfer acceptance and recovery |
| Reward `EPOCH_PUBLISHER_ROLE`           | Publish the next immutable, exactly funded epoch                                                | `publicationDelay`; sequential ID; exact `msg.value == rootSum`; usable only while unpaused                         | Can publish a fully funded but unfair or incorrect allocation                                    | Separate reviewed holder; independently approve dataset/root/sum/window before signing            |
| Reward `PAUSER_ROLE`                    | Pause and unpause publication, claims and clawback                                              | No additional timelock; same role performs both actions                                                             | Compromise can stop or resume mutations; loss can leave the system stuck until admin replaces it | Separate emergency holder and rehearsed pause/unpause/replacement procedure                       |
| Reward `CLAWBACK_ROLE`                  | After expiry and delay, move unclaimed epoch liability                                          | Destination is the immutable treasury; caller cannot choose recipient                                               | Premature use is blocked, but compromise can trigger eligible clawbacks immediately              | Separate holder; monitoring and two-person operational approval                                   |
| Reward treasury                         | Receive expired unclaimed liability                                                             | Immutable constructor address; no general withdrawal function                                                       | Wrong or unavailable address requires a new contract version; rejecting transfers block clawback | Durable reviewed multisig-shaped recipient; receive-path rehearsal before deployment              |
| Reward claimant / relayer (any address) | Submit a proof paying the leaf’s fixed account                                                  | Claim window, bitmap replay protection, proof and accounting checks                                                 | Malformed/replayed proofs revert; a rejecting recipient can deny its own payment                 | Relayers never choose the paid account or amount outside the proof                                |
| Attestation issuer (`msg.sender`)       | Issue, supersede and revoke only its own records                                                | Issuer-scoped nonce/replay key; same issuer/schema/subject supersession; irreversible terminal states               | Key compromise allows false new claims and revocation of active issuer records                   | Applications must present the issuer address and status, never verified real-world identity       |
| Attestation reader (any address)        | Read and verify stored commitment/status                                                        | Verification proves active state, issuer and exact commitment only                                                  | Mislabeling can turn byte equality into a false truth/identity claim                             | Follow canonical-byte and privacy non-claims in public interfaces                                 |

The reward constructor does not require different addresses for its roles.
Therefore role separation is a deployment-policy gate, not a contract
invariant. No public-shaped deployment may assign all roles to one disposable
test key. Factory and attestation are deliberately unpausable and have no
owner, upgrader or recovery role; remediation requires a new version and, when
applicable, consumer migration.

Irreversible facts requiring explicit sign-off are: CREATE2 salt/init-code
address selection; reward treasury and delays; each published epoch root,
funding and window; claimed bitmap entries; completed clawback; attestation
replay keys, supersession and revocation; and every immutable deployed runtime.

There are no proxies or initializer functions in v0. The reward distributor is
configured once by its constructor; factory and attestation have no constructor
configuration. A changed implementation or mistaken immutable configuration
requires a separately reviewed deployment and explicit consumer migration.

## Threat-to-evidence mapping

This table specializes chain risks T006, T015, T016, T017, T021 and T025 for
the current contracts. “Current evidence” means repository evidence, not an
external assurance conclusion.

| Threat / reviewer question                                   | Current control and evidence                                                                                                         | Open audit focus                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| T015/T025: privileged role compromise, loss or collapse      | Separate reward roles; delayed default-admin transfer; fixed treasury; role/pause/admin tests                                        | Distinct-holder enforcement, multisig behavior, immediate role grant/revoke exposure, pause recovery and compromised-role rehearsal         |
| T015/T025: underfunded or inconsistent reward liabilities    | Merkle-sum root binds aggregate; exact publication funding; global and per-epoch accounting; two stateful invariants                 | Multi-epoch/adversarial sequences, forced native value, integer bounds, liveness and reconciliation against events                          |
| T015/T025: proof, claim or replay bypass                     | Epoch/index/account/amount leaf, sum-aware proof, claimed bitmap, immutable roots and fixture tamper tests                           | Differential proof implementation, large/degenerate trees, duplicate allocation policy and gas/denial-of-service limits                     |
| T015: reentrancy, rejecting receivers and denial of service  | Checks/effects before transfer, `nonReentrant`, rollback tests, fixed clawback recipient                                             | Gas griefing, malicious account/treasury behavior, pause interactions and permanent liveness loss                                           |
| T016: deterministic-address or runtime substitution          | CREATE2 derivation plus exact runtime hash, collision/value/error tests, registry artifact/code hashes                               | Salt/init-code ownership conventions, constructor-argument provenance, metamorphic/self-destruct assumptions and public deployer provenance |
| T025: attestation impersonation, replay or ambiguous status  | `msg.sender` issuer, chain/registry/issuer/nonce ID domain, permanent issuer replay key, terminal status tests and canonical vectors | Key compromise, copied calldata semantics, state/event indexing, long supersession chains and storage growth                                |
| T025: false truth, identity, privacy or time claim           | Hash-only storage and explicit canonical hashing/privacy/non-claim docs                                                              | Low-entropy commitments, UI/API wording, off-chain retention and independent identity/authorization protocols                               |
| T006/T016/T021: artifact, ABI, compiler or dependency tamper | Digest-pinned toolchain, source-bound compiler metadata, generated checksums, registry validation and drift checks                   | Clean-builder reproduction, SBOM/advisory review, second reviewer, signed provenance and final bundle checksum                              |
| T017: gas or unbounded state growth                          | Pinned attestation, reward and factory lifecycle snapshots in the canonical contract gate                                            | Sustained attestation/reward state growth and public fee/capacity assumptions                                                               |
| T015/T025: event/state divergence                            | Exact factory, reward and attestation lifecycle event-to-state tests plus state-based queries                                        | Consumer reconciliation, missing-event detection and behavior across reverts/reorgs                                                         |

## Current verification and known limitations

The canonical local gate is `make -C contracts check`. It pins and verifies the
toolchain, checks formatting and Forge lint, builds, runs unit/fuzz/invariant
tests, enforces the line-coverage floor, runs network-disabled fixture tests,
checks generated drift and validates the registry. It also enforces both gas
snapshots and reproduces the ignored offline audit bundle twice.

The current evidence includes reward funding/proof/reentrancy/pause/admin tests,
role-loss recovery, exact lifecycle events, deep-proof domain separation, two
reward fuzz properties and two stateful accounting invariants; factory unit,
value-forwarding fuzz and exact event tests; attestation unit/fuzz/event tests
plus a bounded stateful lifecycle invariant; tamper-resistant offline fixtures;
and eight pinned gas entry points. It does not close these gaps:

- no external audit, independent retest, formal verification or mutation
  testing has occurred;
- Forge lint is the only configured Solidity static analyzer; an independent
  analyzer and review of its suppressions/results are not yet in the bundle;
- the coverage gate is line coverage, not proof of branch, path or invariant
  completeness;
- gas snapshots are narrow regression signals rather than public fee or
  throughput claims, and they do not model long-horizon state growth;
- no public constructor configuration, role assignments, multisig/timelock
  deployment, key-recovery rehearsal or live runtime-code evidence exists;
- reward allocation fairness remains publisher-controlled, and forced surplus
  has no general withdrawal path;
- factory and attestation have no emergency pause or migration coordinator by
  design;
- attestation hashes do not provide confidentiality, availability, identity,
  truth or legal time, and predictable inputs remain dictionary-attackable;
- cross-contract, precompile-to-contract and long-horizon state-growth
  invariants remain evidence gaps this package records and the launch security review must verify before accepting
  the handoff; and
- no finding register currently demonstrates that all high/critical findings
  are explained, remediated and independently retested.

These are release blockers or explicit reviewer questions, not silently
accepted risks.

## Deployment-procedure boundary

This procedure defines evidence required by a future deployment; it does not
authorize one.

1. Cut a clean reviewed commit and immutable audit bundle; record its checksum,
   exact toolchain, dependencies, configurations, exclusions and finding state.
2. Run the full contract gate, gas checks and independent analysis on that
   exact commit. Resolve or formally route every finding before changing any
   registry status.
3. Select an explicit environment/chain ID and production-shaped role matrix.
   Use separate durable holders, a nonzero default-admin delay, reviewed
   publication/clawback delays and a fixed treasury. Rehearse multisig calls,
   default-admin transfer/acceptance, pause recovery and treasury receipt.
4. Encode and peer-review constructor arguments, init code, salt, expected
   address and creation/runtime hashes. Never use the valueless local fixture
   deployer as a public authority or store signing material in the repository.
5. Simulate the complete sequence against the intended chain configuration.
   An independent reviewer compares emitted facts and state to the approved
   manifest before any real broadcast.
6. After an explicitly authorized broadcast, record chain identity, address,
   transaction/block provenance, constructor values, role assignments,
   runtime-code hash and verification evidence. Fail closed on any mismatch.
7. Confirm role separation and immutable values from chain state, complete any
   reviewed default-admin handoff, remove unintended temporary roles and
   rehearse monitoring/recovery queries.
8. Only the public-launch gate may approve a public environment, and only the launch security review may mark the
   contract security-review handoff ready. Generated artifacts, predicted
   addresses and local Anvil evidence are never deployment proof.

## Finding, remediation, retest and disclosure workflow

1. Assign every observation an immutable finding ID, affected commit/files,
   reporter, reproduction/evidence, impact, likelihood, severity, owner and
   disclosure state. Do not place secrets or exploit material in public issues.
2. Classify contract impact as:
   - **critical:** direct or systemic loss/creation/lock of value, arbitrary
     privileged control, universal authorization/proof bypass or unsafe
     deployment substitution;
   - **high:** material value/accounting/control/liveness failure requiring
     realistic preconditions or affecting a bounded component;
   - **medium:** limited-impact correctness, griefing, monitoring or recovery
     weakness without direct critical control;
   - **low:** defense-in-depth or low-impact edge case; and
   - **informational:** maintainability or clarity with no demonstrated
     security impact.
3. Reproduce against the pinned bundle. If validity or severity is disputed,
   preserve both analyses and assign an independent tie-break reviewer; never
   erase or downgrade a finding because it is inconvenient.
4. Remediate in a linked issue/branch with the smallest reviewable change. Add
   a regression that fails before and passes after, then rerun targeted tests,
   the full contract gate, gas checks, artifact generation and checksum review.
5. Retest on the final candidate commit. Critical/high closure requires a
   reviewer other than the patch author and, after an external engagement, the
   auditor's retest or explicit written disposition.
6. Track `open`, `acknowledged`, `remediated`, `retested`, `accepted-risk` or
   `not-applicable` with dated evidence. This package does not grant authority to
   accept a critical/high public-release risk; any exception requires the
   named launch-security risk-acceptance path and remains subject to the public-launch gate.
7. Use the repository private security-advisory intake referenced by
   `packages/torium-sdk/SECURITY.md`. Keep a vulnerability embargo until a fix,
   retest and release/communication plan exist. The launch security review must assign contacts,
   response targets, disclosure timing and incident escalation before launch.

## Launch security review handoff checklist

The audit-readiness package is ready to hand off only when all boxes below have durable evidence:

- [ ] clean source commit and immutable bundle checksum recorded;
- [ ] exact compiler, settings, dependencies, artifacts and exclusions pinned;
- [ ] role holders/configuration either explicitly marked unassigned or
      reviewed for the target environment;
- [ ] unit, integration, fuzz, invariant, coverage, gas and static-analysis
      evidence collected with no unexplained failure;
- [ ] every known finding has severity, owner, remediation and retest state;
- [ ] no unexplained high/critical finding remains;
- [ ] known limitations and cross-boundary risks are included; and
- [ ] an independent reviewer confirms the bundle matches this scope.

The launch security review consumes and checksums that exact bundle, selects the external-review
process, owns disclosure/incident policy and routes contract findings back to
this package or linked remediation work. Until that happens, this package remains an
internal audit-readiness draft.
