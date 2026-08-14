# Source attribution and licensing policy

Torium EVM is based on upstream Cosmos EVM and its transitive Cosmos SDK,
CometBFT and go-ethereum components. The currently validated upstream baseline
is recorded in `chain/poc/upstream-baseline/pins.json` and the corresponding
decision record.

## Rules

1. Copied or modified upstream files retain their original copyright, SPDX
   identifier, license text and source reference.
2. A vendored or forked component must record upstream repository, tag/commit,
   local modifications and license in a machine-readable third-party notice
   before it becomes a release input.
3. Generated files retain the license required by their source and include a
   `DO NOT EDIT` notice. Generation does not erase upstream attribution.
4. New Torium-authored chain, contract and SDK code does not receive an assumed
   public license. The repository owner/legal reviewer must choose and add the
   license before any public package, binary or source release.
5. Until that choice is recorded, packages remain private and publish/release
   automation must fail closed.

This document is an engineering control, not a grant of rights or a substitute
for the upstream license files included with a future fork.

## Recorded license decision

Apache-2.0 was selected by the repository owner on 2026-08-10 for
Torium-authored chain, contract and SDK code (root `LICENSE`). Vendored and
upstream components keep their original licenses per the rules above.
