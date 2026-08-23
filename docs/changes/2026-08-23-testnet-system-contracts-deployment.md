# Change: System contracts deployed to the public testnet

## Summary

The pinned system contracts were deployed to `torium-testnet-1` on 2026-08-23:
`ToriumCreate2Factory` at `0x2334774dFdE49c611C3a270B0F391a7cf581AfF7`
(nonce-zero CREATE from a dedicated operator-held authority),
`ToriumAttestationRegistry` at `0x17e64A025e33865005B2cC793b093Dc2DB57bdc4`
and `ToriumRewardDistributor` at `0x4027605E944b961Bdbba9f97db85F0530B0a6652`
(both CREATE2 through the factory, which enforces the expected runtime code
hash on chain). The native TOR precompile at
`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` was already registered in the
testnet genesis.

## Files/Surfaces Changed

- `contracts/script/deploy-testnet.mjs` + `contracts/script/README.md` — the
  reviewed deployment automation: caller-provided RPC and signing material,
  explicit chain-identity check, pinned-artifact verification before sending,
  runtime-code-hash verification after, idempotent reuse, non-secret output.
- `contracts/config/testnet-deployment-v1.json` — the reviewed deployment
  input: authority, salts and reward-distributor constructor values.
- `contracts/deployments/testnet.json` +
  `contracts/deployments/deployment-registry-testnet-v1.schema.json` — the
  broadcast deployment registry.
- `contracts/scripts/validate-testnet-registry.mjs` — offline validation wired
  into `npm run validate:registry` (and therefore `make -C contracts check`):
  recomputes the CREATE/CREATE2 addresses, salts and init-code hashes from the
  pinned artifacts and requires exact agreement with the localnet code
  identity and the reviewed configuration.
- `chain/releases/network-artifacts-v0.json` (bundle `0.2.0-testnet.2`) — the
  testnet environment now records the deployed contract addresses.
- `apps/developer-docs/content/docs/v0/contracts/index.mdx` — testnet address
  table and provenance links.

## Behavior

The reward distributor uses a single operator-held authority for the admin,
publisher, pauser and clawback roles, a distinct treasury (the faucet cold
reserve), a one-day default-admin delay, a one-hour publication delay and a
one-day clawback delay. These are valueless-testnet choices. No reward epoch
has been published. The attestation registry is permissionless and self-issued.

## Verification

Deployment transactions are recorded in the registry and visible on the
public explorer; runtime code hashes were enforced on chain by the factory and
re-verified by the automation. `make -C contracts check` passes with the new
offline registry validation, and the network-artifacts bundle regenerates
cleanly with the contract addresses.

## Follow-ups

- Publishing a first reward epoch and exercising a claim end to end on the
  testnet remains open.
- SDK generated deployment metadata still describes the localnet only; a
  future SDK release can surface the testnet addresses.
