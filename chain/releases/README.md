# Torium network artifacts v0

This directory packages canonical network metadata into one deterministic and
machine-validated bundle: the full localnet fixture set plus the identity record
of the live public testnet. It does not create networks, publish registry
entries, select peers, sign genesis, start nodes or deploy anything.

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

The testnet entry records the live `torium-testnet-1` network: its frozen
genesis sha256 (anchored by `chain/genesis/testnet/manifest.json` and pinned as
a schema constant), public HTTPS/WSS endpoints, faucet, explorer and EIP-3085
wallet-add metadata. The testnet genesis file itself is withheld from the
repository while public P2P peering is closed, because its genesis transactions
embed validator node IDs; the sha256 anchor is authoritative. Devnet and
mainnet entries remain identifier reservations only. Before any future
publication, identifier availability must be rechecked and a fresh public
genesis must use fresh Cosmos and EVM replay-domain IDs.

Prove the bundle is actually consumable with the chain-start rehearsal, which
boots the localnet from a clean reset and asserts the loaded genesis bytes and
live chain identity against every consumable bundle field:

```bash
./chain/releases/rehearse-chain-start-v0.sh [--keep-running]
```

The bundle is not release-ready because genesis signing custody, registry
submissions, and devnet/mainnet artifacts are still missing; localnet
consumption was rehearsed on 2026-07-29, testnet consumption is exercised by
the live network, and devnet/mainnet consumption stays unexercised.
