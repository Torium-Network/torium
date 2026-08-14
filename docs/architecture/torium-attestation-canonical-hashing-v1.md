# Torium attestation canonical hashing v1

Status: local implementation contract for the attestation-registry design. This specification does
not publish an attestation-registry address or claim a network deployment.

## Canonical content bytes

Algorithm identifier: `torium-attestation-canonical-bytes-v1`.

The algorithm hashes the exact caller-selected byte sequence with Keccak-256:

```text
contentHash = keccak256(exactBytes)
```

There is deliberately no implicit preprocessing:

- no JSON Canonicalization Scheme or object-key sorting;
- no whitespace, newline or numeric normalization;
- no Unicode normalization, case folding or locale conversion;
- no URI parsing, resolution, percent-encoding or normalization; and
- no text-encoding detection.

Text-producing applications must explicitly choose and document UTF-8. They
must persist the exact bytes they hashed. Visually equivalent Unicode NFC and
NFD strings are different byte sequences and intentionally produce different
hashes. Two semantically equivalent JSON documents with different bytes also
produce different hashes.

The offline canonical vector at
`contracts/fixtures/attestations/canonical-hash-v1.json` is the normative
cross-language reference. It records exact UTF-8 bytes, expected Keccak-256 and
ABI-encoding vectors. SDKs must reproduce those values byte-for-byte rather
than introducing a hidden normalization layer.

## Attestation commitment

The record commitment is the Keccak-256 hash of standard ABI encoding in this
exact order and with these logical fields:

```text
schemaId,
uint32 schemaVersion,
subject,
referenceHash,
contentHash,
metadataHash,
metadataUriHash,
supersedes
```

`subject` and `referenceHash` are distinct `bytes32` fields. `referenceHash` is optional
and uses `bytes32(0)` when absent. `metadataUriHash` commits to URI bytes but the
URI itself must remain off-chain. Callers must follow the same exact-byte rule
when deriving any of these hashes.

The attestation identifier additionally binds the current chain, registry
instance, issuer address and issuer nonce before the commitment. Consumers
must not recompute an identifier without all five domain values.

Duplicate prevention uses a separate issuer-scoped replay key over the payload
fields excluding `supersedes`. The same issuer cannot replay identical payload
fields under a later nonce or bypass the duplicate rule by changing only the
supersession pointer. This replay key is not global: different issuers may
independently commit the same payload.

## Privacy requirements

Keccak-256 does not make personal or sensitive data anonymous. Low-entropy
values remain vulnerable to enumeration and dictionary attacks. Do not put raw
personal data, secrets, large payloads or plaintext metadata URIs on-chain.

When confidentiality matters, applications need a separately reviewed
commitment construction, including adequate random salt or a keyed mechanism,
and must manage that material off-chain. This raw canonical-byte algorithm
provides deterministic integrity only.

## Non-claims

A matching hash proves only byte equality with a commitment. It does not prove:

- who created or owns the content;
- whether the issuer's claim is true, fair, lawful or authorized;
- whether the content remains available;
- whether a wallet address maps to a real-world identity; or
- a legally recognized creation or signing time.

The issuer field authenticates only the transaction sender address. Chain
timestamps and inclusion order are protocol observations, not legal timestamp
services.

## Reproducibility checklist

1. Obtain the exact original bytes; do not start from a parsed representation.
2. If the application starts from text, encode explicitly as UTF-8 once.
3. Compute Keccak-256 without normalization.
4. Compare against the canonical vector file.
5. ABI-encode the commitment fields in the exact documented order and types.
6. Bind chain ID, registry address, issuer and nonce when deriving an
   attestation identifier.
