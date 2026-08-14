# Torium operator recovery v0

This directory defines the local-only production-shaped recovery contract for
the node-recovery workstream. It does not activate pruning, state sync, snapshot publication,
backup storage, encryption, retention, or a public restore workflow.

Validate the offline contract with:

```bash
node chain/recovery/validate-recovery-v0.mjs
```

The validator cross-checks the canonical identifiers, trust and threat models,
all five node-role storage policies, the developer-recovery source fields,
the H/H+1 app-hash convention, signer-state exclusions, nullable recovery
objectives, and every HOLD owner. It does not start the chain or mutate a local
runtime.

## What is reusable from the developer-recovery spike

`torium-localnet-recovery-v1` already has strict chain/genesis/binary identity,
committed height/block/app hashes, file checksums, bounded extraction, staged
validation, and atomic activation. Those field meanings are shared with the
operator contract.

The local archive itself is not promoted. It may contain public deterministic
fixture keys, is unsigned and unencrypted, assumes four local validators, and
provides integrity rather than authenticity. An operator snapshot needs a
separate signed application-snapshot envelope and independent trust anchors.

## Activation boundary

Every numeric pruning window, state-sync trust input, provider, endpoint,
signature scheme, backup destination, retention value, encryption key, access
principal, RPO, and RTO stays null or inactive until it is selected and
measured. A zero copied from the node-role exposure contract remains evidence of an inactive placeholder;
it must never silently become an effective runtime value.

See the
[operator runbook](../../docs/operations/torium-chain-recovery-runbook.md) and
recorded recovery design.
