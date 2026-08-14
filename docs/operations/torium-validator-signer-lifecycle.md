# Torium key lifecycle and compromise runbook v0

Status: authored for local review; no public ceremony or incident drill has
passed.

This runbook covers the key classes registered in
`chain/security/key-custody-v0.json`. It does not configure production custody,
select operators, activate a remote signer, or authorize a public launch. Every
procedure begins by deciding whether the event is an **availability failure**
(the legitimate key cannot currently be used) or a **suspected compromise**
(another party may be able to use it). Availability pressure never overrides
double-sign, revocation, or evidence-preservation requirements.

Never paste private material, mnemonics, recovery shares, signer state, raw
environment output, or unredacted diagnostics into a ticket, chat, log,
support bundle, or repository. Record public identifiers, timestamps, heights,
checksums, and redacted command outcomes instead.

## Shared response sequence

For a lost, stolen, corrupt, or suspected key:

1. Classify the event as unavailable, compromised, or both. Treat uncertainty
   as suspected compromise.
2. Stop or pause the affected authority before attempting recovery. Preserve
   read-only evidence and record who made each decision.
3. Revoke, disable, fence, or remove the old authority using the mechanism
   specific to that key class. Absence of a mechanism is a launch blocker, not
   permission to improvise.
4. Generate or recover a replacement only through the ratified custody path.
   Verify its public identifier independently before activation.
5. Review the period of possible exposure for unauthorized votes,
   transactions, releases, artifacts, peer identities, or decryptions.
6. Communicate the affected authority and trust impact without disclosing
   secret material. Preserve evidence until the incident owner authorizes its
   destruction.

## Consensus signer

The validator consensus signer can sign CometBFT proposals and votes. A lost or
corrupt signer is primarily an availability event; a copied, stolen, exposed,
or ambiguously restored signer is a compromise and double-sign risk.

- Stop the validator and prove that no clone, failover process, or old host can
  sign. Do not trade double-sign safety for uptime.
- Do not edit `priv_validator_key.json` or `priv_validator_state.json`, reset
  height/round/step, copy a signer into two homes, or start a candidate merely
  because it has the expected public key.
- For a same-identity local restore candidate, keep both homes offline and run:

  ```bash
  node chain/operator/signer-state-guard.mjs \
    --current-home /offline/current-home \
    --candidate-home /offline/candidate-home \
    --trusted-maximum-height 12345 \
    --validator-stopped
  ```

  The guard requires the private-key seed to derive the recorded public key,
  the FilePV signature to verify over Comet's uppercase-hex sign bytes, the same
  derived consensus identity, strict file modes, and a candidate
  `(height, round, step)` that is not behind the current state or above the
  independently reviewed signer-height ceiling. Equal positions must have
  identical sign bytes and signatures. Its output contains positions only. The
  `12345` value is illustrative; an operator must derive the ceiling from
  reviewed recovery/consensus evidence. The guard does not yet decode the
  canonical vote/proposal to prove its chain ID and embedded H/R/S. A passing
  result also does **not** prove that an active clone is absent, and runtime
  admission is not wired in v0.

- If compromise is suspected, do not restore the old identity. Preserve
  evidence, keep every copy stopped, determine the last trustworthy signing
  point, and replace the validator with a new consensus identity through the
  reviewed validator-set transition. In-place private-key replacement is not a
  supported rotation path.
- Review the exposure interval for conflicting votes and proposals, record
  public consensus evidence, and communicate finality/validator-set impact.

No live replacement or restored-signer startup drill has passed. The signer-custody workstream remains
HOLD until active-clone fencing, custody, operator admission, and replacement
drills exist.

## P2P identity

A missing or corrupt P2P node identity affects peer reachability. A copied or
stolen identity permits peer impersonation but does not grant consensus signing
authority.

- Stop the affected node and remove the old node ID from reviewed peer and
  allowlist records.
- Preserve connection logs without environment dumps or key files, then review
  the exposure interval for unexpected peers or duplicate node-ID behavior.
- Generate a unique replacement while the node is stopped, restrict the node
  home to its process user, update peer records, and restart through the role
  profile checks.
- Communicate the node-ID change and topology impact to peer operators. Never
  reuse a validator's P2P identity for another role.

## Operator account

The validator operator account controls staking, commission, reward, and
unjail transactions; it is separate from the consensus signer. Loss may leave
the validator operational but administratively unavailable. Suspected exposure
can authorize unwanted transactions.

- Stop operator transactions and review account sequence, balances, staking
  changes, reward withdrawals, and unjail actions for the exposure interval.
- Do not deliver an operator key to the validator process or treat recovery of
  the consensus signer as recovery of this account.
- Use only a ratified protocol transition or validator replacement to move
  authority; no in-place operator-address rotation is assumed.
- Revoke old custody access, create the replacement through the approved
  ceremony, verify the public address independently, and communicate staking
  and commission impact.

## Governance

No production governance multisig, threshold, holders, or recovery ceremony is
configured. Local governance uses disposable test accounts and the Cosmos
governance module authority.

- Freeze high-impact proposal and administrative transaction preparation when
  a future approver is lost, stolen, corrupt, or suspected.
- Review proposals, deposits, votes, and authority transactions during the
  exposure interval. Preserve unsigned and signed transaction evidence without
  disclosing shares.
- Revoke or replace the approver only through the ratified governance
  mechanism and required independent approvals. Never invent an emergency
  administrator or bypass proposal rules.
- Communicate whether quorum, proposal timing, or upgrade authority is affected.

Public governance custody remains HOLD under tracked follow-up work.

## Deployer

The system-contract deployer is a one-shot deployment identity. It must not
silently retain permanent administrative authority.

- Pause deployments and role handoffs, review deployments and contract role
  events during the exposure interval, and compare them with the reviewed
  deployment registry.
- Revoke or transfer every protocol-supported role before retiring the old
  identity. If a role cannot be revoked safely, stop and escalate; do not deploy
  a replacement contract as an unreviewed workaround.
- Generate a replacement through the approved deployment ceremony, verify its
  address independently, and resume only with a reviewed deployment plan.
- Communicate affected contracts, roles, registries, and artifact provenance.

## Faucet

The current faucet key is a public deterministic, valueless local fixture, not
a production secret. It must never be reused for public value. A future public
faucet requires an isolated hot signer and abuse controls owned by a follow-up workstream.

- Pause the faucet before recovery or rotation and prevent new allocations.
- Reconcile the funding account's confirmed and pending nonce/sequence and
  review transfers during the exposure interval.
- For a future public signer, revoke service access, fund a newly generated
  bounded replacement, update the reviewed faucet policy, and retire the old
  signer only after pending transactions are resolved.
- Communicate funding limits and user impact without exposing signer material.

The local fixture needs no secret backup. Public signer implementation,
monitoring, rotation, and incident drills remain HOLD.

## CI identity

No chain release workload identity is configured in localnet. A future CI
identity must be short-lived and least privilege.

- Freeze affected builds, publications, attestations, and environment changes.
- Revoke the provider grant or workload binding; do not rotate by placing a new
  long-lived credential in repository settings or source.
- Review workflow runs, permission changes, artifacts, and provider audit logs
  for the exposure interval.
- Reissue the workload binding through reviewed provider controls, then rebuild
  from clean source. Communicate which artifacts or environments lost trust.

## Snapshot publisher

No snapshot publisher algorithm, key, or trust anchor is selected. Operator
snapshot data is not authoritative merely because it has a checksum.

- Quarantine snapshots and manifests signed during the exposure interval and
  remove the old publisher from trust metadata.
- Preserve detached signatures, public key IDs, checksums, timestamps, and
  distribution logs; never bundle a signer or backup-encryption key.
- Publish reviewed replacement trust metadata, allow a bounded overlap only if
  the ratified policy permits it, and reissue trustworthy snapshots.
- Communicate affected heights, manifests, mirrors, and restore guidance.

## Release signing

No binary, container, SBOM, or provenance signing identity is configured.

- Freeze releases and distribution from the affected workflow.
- Revoke the signing identity or workload grant and mark artifacts from the
  exposure interval untrusted.
- Review source commits, workflow definitions, build logs, SBOMs, provenance,
  signatures, registries, and downloads for unauthorized changes.
- Rebuild from clean reviewed source, sign with the replacement identity, and
  publish revocation/replacement metadata before resuming distribution.

## Backup encryption

No backup encryption provider, algorithm, threshold, or custodians are
selected. A lost decrypt capability is an availability problem; exposure can
disclose retained backups and every authority they contain.

- Stop backup deletion, key rotation, and restore attempts until the affected
  envelope set and exposure interval are known.
- Preserve encrypted backups, metadata, access logs, and public key IDs without
  copying them into support bundles. Quarantine any backup that may include a
  consensus key or signer state outside its separately approved envelope.
- Revoke old decrypt authority, recover or generate replacement authority
  through the ratified share ceremony, verify independent recovery, and rewrap
  retained backups before old access is destroyed.
- Communicate affected retention windows, restore capability, and possible data
  disclosure. Do not claim recovery until an independent restore drill passes.

## Drill and activation boundary

Every section is `authored-not-drilled`. Public activation requires named
operators and custodians, two-person controls, selected generation/storage/
backup/revocation/destruction mechanisms, active-clone fencing, remote-signer
or FilePV custody decisions, consensus replacement testing, public faucet
isolation, CI/release identity controls, and measured recovery evidence. These
are explicit HOLDs, not implied future behavior.
