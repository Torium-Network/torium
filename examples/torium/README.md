# Torium local developer examples

These examples exercise the public `@torium-network/sdk` entry points against Torium Localnet. They
default to `http://127.0.0.1:8545`, stop on a different chain ID, and contain no production endpoint
or reusable account material.

| Example                | Current proof                                                  | Runtime follow-up                            |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Node CLI               | typechecked; status, balance, transfer and receipt commands    | one bounded localnet smoke in the live-integration follow-up           |
| Browser wallet         | Vite build, module/size audit and EIP-1193 mocks               | live injected wallet in the live-integration follow-up                 |
| React Native boundary  | Metro-generated Hermes bytecode and module/size audit          | live device/network journey in the live-integration follow-up          |
| Solidity               | Counter compiles with pinned Hardhat; Foundry config is pinned | deploy/call smoke in the live-integration follow-up                    |
| Reward and attestation | not published                                                  | generated system-contract bindings from the generated-bindings follow-up |

## Prerequisites

- Node.js 22.23.1 (or a supported Node 24 release) and pnpm 10.27.0
- a running Torium Localnet for runtime commands
- a disposable funded localnet account only for write examples

From the repository root:

```bash
pnpm install --filter @torium-network/examples...
pnpm --filter @torium-network/examples build
pnpm --filter @torium-network/examples validate
pnpm --filter @torium-network/examples verify:browser-runtime
pnpm --filter @torium-network/examples verify:hermes-runtime
```

The repository links SDK `0.1.0` through pnpm workspaces. Example source imports only documented package
entry points; it does not import `packages/`, `chain/`, or generated workspace internals. Registry-only
installation becomes an npm release gate later.

## Runtime configuration

`TORIUM_RPC_URL` may override the loopback HTTP endpoint. The examples still require the canonical
Torium Localnet chain ID. Write commands read `TORIUM_EXAMPLE_SIGNER_KEY` at runtime; no key is
included, logged, or persisted. SDK-backed writes ask for approval after showing the exact fresh
preflight. The Foundry script checks the numeric localnet chain ID before its explicit broadcast and
verifies final contract state. Never reuse that disposable account outside a local chain.

`runtime-matrix.json` records the Node module formats, web/Hermes requirements and reviewed bundle
budgets. Browser and Metro source maps are checked for Node polyfills and Torium product-backend
dependencies. These are bundler/runtime-compatibility proofs, not a live device, wallet extension, or
public-network certification.

Expected values such as block number, fee, transaction hash and contract address vary per run. Stop
the localnet when finished and remove generated `dist`, Hardhat `artifacts`/`cache`, and Foundry
`out`/`cache` directories with `pnpm --filter @torium-network/examples clean`.
