# Injected browser wallet

Build the static Vite application:

```bash
pnpm --filter @torium-network/examples build:browser
pnpm --filter @torium-network/examples exec vite --config browser/vite.config.ts
```

Open the printed loopback URL with an injected EIP-1193 wallet already configured for Torium
Localnet. The page rejects a wallet or RPC on the wrong chain, displays the connected balance, then
lets the wallet review a zero-value self-transfer. Expected output progresses from `Acknowledged`
to `committed`, `reverted`, or `unknown` plus the transaction hash.

The example does not silently add or switch networks. Disconnect the site in the wallet, stop Vite
and localnet, and delete `dist/browser` when finished.
