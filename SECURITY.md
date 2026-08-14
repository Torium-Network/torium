# Security Policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately through
the repository's
[security advisory form](https://github.com/Torium-Network/torium/security/advisories/new).

Never include private keys, mnemonics, seeds, keystores, or key bytes in a
report. `torium-testnet-1` and all local networks use valueless test currency;
still treat any key material as sensitive.

## Scope

- `chain/` — the Torium EVM L1 node, configuration contracts, and tooling
- `contracts/` — the system contracts
- `packages/torium-sdk/` — the published `@torium-network/sdk` package
- `.github/workflows/` — the release and publishing pipeline

## Supported versions

Only the latest published SDK version and the current `main` branch receive
security fixes. A bad SDK release is deprecated on npm and superseded by a
fixed release; versions are never unpublished.
