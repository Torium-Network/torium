# Torium local faucet acceptance

This suite proves that the loopback-only, valueless local faucet submits a real
EIP-1559 native transfer to the canonical four-validator chain. It compares the
recipient balance through Ethereum JSON-RPC, Cosmos REST, and the `toriumd`
AutoCLI query, then confirms every validator committed the receipt block.

It also exercises a disposable deterministic `test` keyring, offline signing,
a randomly generated manual-test recipient, cooldown and amount limits, strict
input decoding, and non-reflection/non-logging of secret-shaped input. No key or
mnemonic is written to the repository or emitted in the proof.

Run from the repository root:

```bash
make -C chain/tests/faucet test
```

The suite resets local chain state and stops all services on completion. On
failure it writes public diagnostics to the ignored
`chain/tests/faucet/.artifacts/` directory. This is not a public faucet security
test; a follow-up workstream owns isolated production signing, persistent/distributed limits,
abuse controls, monitoring, and incident response.
