# Node CLI

Start localnet, then inspect it:

```bash
pnpm --filter @torium-network/examples node status
pnpm --filter @torium-network/examples node balance 0x1111111111111111111111111111111111111111
```

`status` prints JSON with network, chain ID, block height, client version, listening state and peer
count. `balance` prints an exact tTOR value.

To submit from a disposable funded localnet account, review the destination and amount. The CLI then
prints the exact fresh chain, signer, recipient, nonce, gas and fee values and signs only after you
type `yes`:

```bash
TORIUM_EXAMPLE_SIGNER_KEY=0x... \
  pnpm --filter @torium-network/examples node transfer 0x1111111111111111111111111111111111111111 0.001
pnpm --filter @torium-network/examples node receipt 0x...
```

The command prints the maximum reviewed cost, acknowledgement hash and committed/reverted/unknown
receipt result. It never retries a write. Unset the write variable and stop localnet afterward.
