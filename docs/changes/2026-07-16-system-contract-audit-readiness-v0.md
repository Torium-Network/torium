# Change: Define the system-contract audit-readiness package v0

## Summary

Issue the audit-readiness slice now has a v0 audit-readiness baseline covering the current native
facade, deterministic factory, reward distributor and attestation registry. It
adds assurance tests, gas regression evidence, a reproducible offline bundle,
exact scope and exclusions, role and irreversible-action boundaries,
threat-to-evidence mapping, known limitations, future deployment evidence, and
the finding/remediation/retest/disclosure workflow consumed by the launch security review.

## Surfaces documented

- [`docs/architecture/system-contract-audit-readiness-v0.md`](../architecture/system-contract-audit-readiness-v0.md)
  is the internal reviewer handoff and closure checklist.
- Existing deployment, reward, attestation, canonical-hashing and chain threat
  documents remain the design sources linked by that package.
- [`docs/architecture/README.md`](../architecture/README.md) indexes the new
  handoff.

## Current boundary

This change creates no role, signer, deployment configuration, address or
transaction. It adds offline assurance tests, gas drift checks and a
self-verifying audit-bundle generator to the existing contract CI gate. It does
not claim an external audit or live deployment. The final clean commit and
audit-bundle checksum remain unassigned until The launch security review consumes a clean handoff.

The largest recorded gaps are independent static analysis/retest, public-shaped
multisig and role-separation rehearsal, cross-contract/state-growth coverage,
a complete finding register, and the launch security review's named disclosure/incident ownership.

## Handoff

the launch security review must consume the exact clean bundle and record its checksum before the
contract portion of launch security review can be called ready. Contract
findings return to this package or linked remediation work and require final-candidate
retest evidence.
