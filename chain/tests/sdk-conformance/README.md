# Torium SDK localnet conformance

Validates the published `@torium-network/sdk` API against the real disposable
localnet instead of mocks. The runner packs the SDK with `npm pack`, installs
the tarball into a throwaway consumer package (no workspace or source
aliases), and executes the suite against `torium-localnet-1`.

```bash
chain/tests/sdk-conformance/run.sh           # run and check the committed matrix
chain/tests/sdk-conformance/run.sh --write   # update proof/sdk-conformance-matrix.json
```

The runner starts the localnet with `chain/localnet/torium-localnet start` if
it is not already running, and stops it afterwards only when it started it
(`TORIUM_CONFORMANCE_KEEP_LOCALNET=1` keeps it up). Every run is naturally
isolated: contracts are deployed fresh from
`contracts/generated/abi/*.json` creation bytecode, so replay guards and epoch
counters never collide across runs against a persistent localnet.

## What the suite proves

- typed reads agree with raw JSON-RPC results; wrong chain definitions fail
  closed before use; documented fee-history limits hold live;
- the full wallet lifecycle (preflight → authorize → submit once → CometBFT
  commit) transfers native value with exact balance deltas;
- both system contracts deploy from generated creation bytecode and the
  deployed runtime bytecode matches the registry-pinned keccak-256 hashes;
  wrong or empty deployments fail closed;
- a live two-leaf Merkle-sum epoch publishes fully funded, claims pay exact
  committed amounts, and double claims/invalid proofs revert with decoded
  custom errors;
- attestations issue under the locally predicted attestation ID, verify
  against locally computed commitments, supersede, revoke, and block replayed
  payloads and foreign revocations;
- WebSocket `newHeads` subscriptions deliver consecutive blocks and HTTP log
  backfill returns the exact events emitted by the run.

Accounts are the public disposable localnet fixtures re-derived from the
documented formula in `chain/localnet/ACCOUNTS.md`; they are valueless and
must never be used outside the localnet.

## Compatibility matrix

`proof/sdk-conformance-matrix.json` is generated only from passing capability
records and contains no timestamps, addresses, or transaction hashes, so a
passing rerun is byte-identical. `run.sh` fails when the committed matrix
drifts from the observed run.

CI: the `sdk-conformance` job in `.github/workflows/chain-e2e.yml` runs this
suite under the same `ci:full-chain-e2e` label gate as the chain acceptance
suites; it is intentionally not part of per-PR CI.
