# Contributing to Torium

Thanks for your interest in Torium! This repository contains the Torium EVM L1
node, system contracts, the `@torium-network/sdk` TypeScript SDK, runtime
examples, and the developer documentation portal.

## Getting started

Prerequisites: Node.js 22.23.1, pnpm 10, Go (see `chain/toolchain.json` for the
pinned version), and Docker for the chain suites.

```bash
pnpm install

# Developer docs portal (http://localhost:3000/docs)
pnpm --filter developer-docs dev

# SDK — full verification (format, types, build, validators, tests, snapshots)
pnpm --filter @torium-network/sdk verify

# Chain unit tests
cd chain/app && go test ./...

# Contracts (requires Docker for the pinned Foundry toolchain)
make -C contracts check
```

## Before opening a pull request

- Run the verification that covers what you changed. CI runs the same gates:
  the SDK workflow, the chain E2E acceptance suites, the performance and
  resilience contract validators, and the secret scan.
- Machine-readable contracts (`chain/config/*.json`, snapshots under
  `packages/torium-sdk/api/`, `chain/releases/network-artifacts-v0.json`) are
  validated by fail-closed scripts. If you change a source value, regenerate
  the dependent snapshot with the documented `--write` flag and commit both —
  never hand-edit generated output.
- All user-facing behavior changes need a matching update in
  `apps/developer-docs` and, for the SDK, a `CHANGELOG.md` entry.
- Keep commits focused and describe what changed and why.

## What we are looking for

- Bug reports with reproducible steps (see the issue templates)
- Fixes and improvements to the SDK, examples, and documentation
- Chain tooling and test improvements

Releases, publishing, and validator/network operations are handled by the
maintainers; pull requests cannot trigger a package publish.

## Documentation

The architecture index at `docs/architecture/README.md` maps every normative
contract and its validator. `chain/REPOSITORY_MAP.md` explains the repository
layout.

## Code of Conduct

By participating you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Never open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
