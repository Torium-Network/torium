# Change: Public testnet reset to genesis 2 (torium-testnet-1)

## Summary

The valueless public testnet was reset on 2026-09-13 with a new genesis
(sha256 `7eb5e332d6a697a1621fedce6b4a378616d3fd6675331a914a1de4492f609dcd`,
genesis time `2026-09-13T11:55:56Z`). Both chain IDs are unchanged:
`torium-testnet-1` / `1414484564`. Genesis 1
(`2d1c52e544f9e611d2d8817d7971eec6580f6dd12ce63131794287c8c91e93be`,
2026-08-18) is retired; its history is not carried over, and the public
endpoints, the ethereum-lists/chains entry and wallet configurations keep
working as before.

## Why

The Torium app moves its previously off-chain testnet wallets onto the chain.
The protocol is genesis-capped and non-inflationary, and genesis 1 (100M tTOR
faucet reserve) could not fund that migration, so the reset adds dedicated
genesis allocations for it.

## What changed

- Genesis allocations: `faucet-reserve` 1B tTOR, `migration-reserve` 10B
  tTOR (cold), `migration-signer` 500M tTOR and `app-faucet-signer` 20M tTOR
  (hot signers operated by the Torium app backend), four validator operators
  at 2M tTOR each, `faucet-signer` 1,000 tTOR. Total supply
  11,528,001,000 tTOR. See `chain/genesis/testnet/manifest.json`.
- System contracts redeployed from the pinned artifacts with the same
  deployer authority from nonce 0 (`contracts/config/testnet-deployment-v1.json`,
  `contracts/deployments/testnet.json`): `ToriumCreate2Factory` and
  `ToriumAttestationRegistry` keep their addresses; `ToriumRewardDistributor`
  is now `0xA836D3Dc1339B69313bf23dBAe67501Ea730Fe34` because its treasury
  constructor argument points at the genesis 2 faucet reserve. Runtime code
  hashes are unchanged.
- Network artifacts regenerated; the genesis hash constants in
  `contracts/deployments/deployment-registry-testnet-v1.schema.json` and
  `chain/releases/network-artifacts-v0.schema.json` follow.
- SDK `0.1.3`: `toriumTestnetContractRegistry` carries the genesis 2 record;
  no runtime behavior changes.
- Developer docs: releases table and contracts address table.

## Verification

- `node contracts/scripts/validate-testnet-registry.mjs`,
  `make -C contracts generate-check`,
  `node chain/releases/generate-network-artifacts-v0.mjs --check`,
  `pnpm --filter @torium-network/sdk run verify`,
  `node apps/developer-docs/scripts/validate-docs.mjs`: green.
- On chain: `eth_chainId` `0x544f5254`, height advancing, archive node and
  Blockscout re-indexed from block 0, deployer transactions observed at the
  recorded blocks.

## Follow-ups

- Explorer source verification of the redeployed contracts.
- Telegram alert routing for the testnet Prometheus alerts (still deferred).
