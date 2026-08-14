# Releasing @torium-network/sdk

This package is currently **unpublished and must stay unpublished** until an
explicit approval. `release/release-policy-v0.json` is the machine-readable
policy; `scripts/validate-release-readiness.mjs` enforces it and runs inside
`pnpm run verify`. This checklist is the human half of the same contract.

## Standing rules

- Publishing happens only through GitHub Actions trusted publishing with npm
  provenance. No long-lived npm token may exist locally, in CI secrets used by
  routine jobs, or in any `.npmrc`.
- `package.json` keeps `"private": true` until the policy flips
  `publishAllowed` in a reviewed change accompanied by explicit approval.
- Two-person review is required for the release commit, which must reference
  this checklist.
- Versioning is semver. Git tags use `sdk-v<version>`; prereleases use
  `<version>-rc.<n>` under the `next` dist-tag; `latest` receives stable
  releases only.

## Pre-release checklist (all blocking)

1. `pnpm --filter @torium-network/sdk run verify` — format, types, build,
   chain/capability validators, tests, package snapshot, release readiness.
2. `chain/tests/sdk-conformance/run.sh` — a fresh passing localnet run whose
   committed compatibility matrix matches the target chain version.
3. `node apps/developer-docs/scripts/generate-sdk-reference.mjs --check` and
   `node apps/developer-docs/scripts/validate-docs.mjs` — docs are current.
4. `CHANGELOG.md` documents the exact version with compatibility notes
   (chain manifest, contracts registry, viem peer range, docs version).
5. npm organization ownership is proven and recorded: organization created by
   an authenticated owner with MFA plus a second owner; identifier
   availability rechecked immediately before publication (a registry 404 is
   not ownership).
6. Explicit approval for the publish exists in the release conversation.

## Publishing (future, after approval)

1. Flip `publishAllowed` and `"private": true` in one reviewed release commit;
   update `releaseReady` only when every gate above is green.
2. Tag `sdk-v<version>` and let the trusted-publishing workflow produce the
   tarball with provenance. Never `npm publish` from a laptop.
3. Verify the published tarball checksum and provenance attestation against
   the reviewed `api/package-files.json`.

## Deprecation and rollback

- `npm unpublish` is not part of the process. A bad release is deprecated with
  `npm deprecate <name>@<version> "<reason + advisory link>"` and superseded
  by a fixed release.
- Deprecation messages must link the relevant advisory or change note.

## Compromised release response

1. Deprecate every affected version immediately with a warning message.
2. Rotate or revoke the trusted-publishing configuration before any further
   release.
3. File a private security advisory (see `SECURITY.md`) and coordinate
   disclosure.
4. Publish a patched release from a clean, re-reviewed checkout with fresh
   provenance.
5. Record the incident and response in `docs/changes/`.
