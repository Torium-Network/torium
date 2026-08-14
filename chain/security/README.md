# Torium chain security contracts

This directory owns the versioned security model for the standalone Torium EVM
L1 workstream. It does not authorize or depend on the existing Torium product
backend, public infrastructure, bridges, IBC, Ethereum L2 behavior, live value,
or deployment.

## Normative sources

- `threat-model-v1.json` — assets, actors, trust boundaries, risk register,
  security invariants, stable test IDs, residual risks, review triggers, and
  public-release gates.
- `threat-model-v1.schema.json` — structural Draft 2020-12 schema.
- `validate-threat-model-v1.mjs` — semantic and cross-contract validation
  against protocol, trust, compatibility, and secret-policy manifests.
- `secret-policy.json` — chain-owned scan scope, prohibited material, rules,
  fail-closed file handling, redacted finding output, and owners.
- `secret-policy.schema.json` — structural schema for the scanner policy.
- `chain/scripts/scan-prohibited-secrets.mjs` — executable source/artifact
  scanner and six-surface self-test.
- `key-custody-v0.json` — local-only key inventory, lifecycle ownership,
  offline signer-restore boundary, compromise runbooks, and explicit public
  activation HOLDs.
- `key-custody-v0.schema.json` — strict structural schema for the custody
  contract.
- `validate-key-custody-v0.mjs` — semantic validation against trust, threat,
  governance, node-role, recovery, local-account, and secret contracts.

Run from the repository root:

```bash
node chain/security/validate-threat-model-v1.mjs
node chain/security/validate-key-custody-v0.mjs
node --test chain/operator/signer-state-guard.test.mjs
node chain/scripts/scan-prohibited-secrets.mjs --self-test
```

The signer-state guard is an offline comparison, not a validator startup gate.
It does not prove that another signer clone is stopped and does not activate a
public custody design. See the
[key lifecycle and compromise runbook](../../docs/operations/torium-validator-signer-lifecycle.md).

The default scanner invocation reads Git-tracked chain, contracts, SDK,
developer-docs, Torium examples, Torium infra, documentation, workflows, and
root package metadata. It intentionally does not claim ownership over the
legacy product apps/backend/infra excluded by the standalone-chain repository
boundary.

## Generated artifact and support-bundle gate

Use explicit path mode for logs, screenshots, image metadata, generated
fixtures, packaged examples, container export staging, and support-bundle
staging:

```bash
node chain/scripts/scan-prohibited-secrets.mjs --path /absolute/staging/path
```

Run the gate **before** archive creation. ZIP, TAR, gzip, oversized files,
symlinks, runtime `.env` files, validator/node key files, and private-key file
extensions fail closed. An archive is never considered safe merely because its
compressed bytes did not match a pattern; extract or generate it into a clean
staging directory, scan that tree, then package the exact scanned files.

The scanner inspects binary buffers as well as text so ASCII credentials in
PNG/JPEG metadata and other binary artifacts are visible. Findings contain
only rule, path, and line; matched credential values are never printed.

## Prohibited material

Do not commit, log, screenshot, package, cache, or attach:

- validator consensus keys, node keys, signer state, mnemonics, seed phrases,
  private keys, keystores, or wallet exports;
- API, npm, GitHub, cloud, Slack, OpenAI-style, bearer, JWT, database, or CI
  credentials;
- runtime environment files, raw environment dumps, unredacted support dumps,
  or production endpoint credentials;
- a deterministic local fixture that could be mistaken for or reused as a
  public/private-value key.

Examples use placeholders such as `<required>`, `<redacted>`, or
`process.env.REQUIRED_NAME`. Placeholder acceptance is not permission to use
weak real credentials. The exact published `blockscout-poc-only` value is
accepted solely as a non-secret password for the isolated loopback PoC database;
it is forbidden in any non-local profile.

Pattern scanning is defense in depth, not proof of absence. Encoded, encrypted,
fragmented, novel, or visual-only secrets can evade rules. CI enforcement in
the diagnostics-redaction workstream, support-bundle allowlisting in the public-hardening workstream, release review in the external security review, and immediate
revocation/rotation on any finding remain mandatory.
