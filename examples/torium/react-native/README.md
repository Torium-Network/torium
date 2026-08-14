# React Native/Hermes compatibility boundary

`compatibility.ts` is a transaction-lifecycle fixture, not an account vault. A host application
supplies an already unlocked viem `Account` through `PlatformAccountProvider`. The account should
delegate signing to a native protected signer or caller-selected wallet provider; recovery phrases,
raw signing material, and generic storage adapters must not enter the SDK.

The host application owns protected storage, unlock/biometric policy, provider sessions, background
locking, user confirmation and cleanup. The fixture performs a chain check, fresh transaction
preflight, explicit review callback, one submission and receipt wait.

`runtime-entry.ts` is bundled with a minimal Metro configuration into Hermes bytecode. Its source map,
module count and bytecode size are audited, and Node polyfills plus Torium product-backend dependencies
are rejected:

```bash
pnpm --filter @torium-network/examples verify:hermes-runtime
```

This verifies Metro/Hermes compatibility for React Native 0.81.5. It does not claim a live device,
specific wallet adapter, protected-storage implementation, or localnet transaction; those integration
journeys remain consolidated under the live-integration follow-up.
