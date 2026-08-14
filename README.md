# Torium

Torium is a sovereign EVM L1 built on the Cosmos stack, with a TypeScript SDK,
Foundry contracts, and public developer documentation.

Public testnet: `torium-testnet-1` — see the developer docs in
[`apps/developer-docs/`](apps/developer-docs/README.md).

## Repository layout

| Path | Contents |
|------|----------|
| `chain/` | The Torium EVM L1 node: app wiring, genesis, localnet, config, security and release gates |
| `contracts/` | Foundry contracts (attestation registry, reward distributor) |
| `packages/torium-sdk/` | `@torium-network/sdk` — TypeScript SDK (viem-based) |
| `examples/torium/` | SDK runtime examples: node, browser, React Native, Solidity |
| `apps/developer-docs/` | Developer documentation portal (Next.js + Fumadocs), served under `/docs` |
| `docs/` | Architecture notes and operator source-of-truth documents |

## Getting started

```bash
pnpm install

# Developer docs portal (http://localhost:3000/docs)
pnpm --filter developer-docs dev

# SDK
pnpm --filter @torium-network/sdk build

# Chain (requires Go — see chain/toolchain.json for the pinned version)
cd chain/app && go test ./...
```

## Licensing

Torium-authored code is licensed under [Apache-2.0](LICENSE). Upstream
components (Cosmos SDK, CometBFT, go-ethereum, Cosmos EVM) retain their
original licenses and attributions — see
[`chain/ATTRIBUTION.md`](chain/ATTRIBUTION.md).
