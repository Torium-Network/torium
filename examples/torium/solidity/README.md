# Solidity deployment and call

`contracts/Counter.sol` is a generic local fixture, not a Torium system contract. Hardhat 3.9.1 and
Solidity 0.8.30 are pinned to the canonical toolchain.

Compile and run the Hardhat-artifact deployment/call script against a funded disposable localnet
account:

```bash
pnpm --filter @torium-network/examples build:contracts
TORIUM_EXAMPLE_SIGNER_KEY=0x... \
  pnpm --filter @torium-network/examples exec tsx solidity/hardhat/deploy-and-call.ts
```

Expected output contains the deployed contract address and `"number": "42"` after the write receipt.
The script rejects a non-localnet endpoint before deployment, asks for approval of the exact fresh
preflight before both writes, requires committed receipts, and verifies the final value.

The equivalent Foundry flow uses `solidity/foundry/foundry.toml` with the pinned Foundry 1.7.1 tool.
The maintained script checks the numeric Torium Localnet chain ID before its first broadcast, then
asserts the final value:

```bash
cd examples/torium/solidity/foundry
./run-localnet.sh
```

Remove Hardhat `artifacts`/`cache` and Foundry `out`/`cache`, unset the signer variable, and stop
localnet afterward. Reward/attestation examples wait for generated bindings and deployments in the generated-bindings follow-up.
