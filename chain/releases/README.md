# Torium network artifacts v0

This directory packages existing, canonical localnet metadata into one deterministic
and machine-validated bundle. It does not create a public network, publish a
registry entry, select peers, sign genesis, start nodes or deploy anything.

Generate and check the committed artifact with:

```bash
node chain/releases/generate-network-artifacts-v0.mjs --write
node chain/releases/generate-network-artifacts-v0.mjs --check
```

`network-artifacts-v0.json` contains the localnet genesis hash, dual chain IDs,
wallet-add metadata, empty peer/state-sync publication fields, and pinned
compatibility versions for the node, SDK, contracts, explorer, roles, recovery
and upgrade contract. `SHA256SUMS` authenticates the generated JSON bytes; it is
not a public genesis signature.

Devnet, testnet and mainnet entries are identifier reservations only. They carry
no genesis, endpoint, wallet, peer, state-sync or snapshot artifact. Before any
future publication, identifier availability must be rechecked and a fresh
public genesis must use fresh Cosmos and EVM replay-domain IDs.

Prove the bundle is actually consumable with the chain-start rehearsal, which
boots the localnet from a clean reset and asserts the loaded genesis bytes and
live chain identity against every consumable bundle field:

```bash
./chain/releases/rehearse-chain-start-v0.sh [--keep-running]
```

The bundle remains HOLD because public signatures/assets/endpoints/peers are
missing; localnet consumption was rehearsed on 2026-07-29 while
public-environment consumption stays unexercised.
