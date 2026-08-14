# Torium localnet recovery and fixtures

This guide covers disposable developer recovery only. Every archive can contain
the public deterministic local validator keys and is marked valueless. It is
not a public-network backup, validator-key escrow, state-sync trust policy, or
operator RPO/RTO design. A follow-up workstream owns production node recovery, state sync,
and RPO/RTO; a follow-up workstream owns validator signer custody and escrow.

## Safe workflow

Create a complete four-validator recovery snapshot:

```bash
./chain/localnet/torium-localnet snapshot \
  --backend container \
  --fixture custom \
  --output "$PWD/chain/localnet/.artifacts/bug-123.tar.gz"
```

`snapshot` stops the selected scope before reading databases and leaves it
stopped. Omit `--output` to use a timestamped ignored path under
`chain/localnet/.artifacts/`. Add `--node validator-3` for a one-node archive;
the other validators remain available. Resume with `start` for a network
snapshot or `restart --node validator-3` for a node snapshot.

Validate an archive without extraction or mutation:

```bash
./chain/localnet/torium-localnet inspect \
  --archive "$PWD/chain/localnet/.artifacts/bug-123.tar.gz"
```

Inspect the committed common anchor of a stopped runtime, or one stopped node:

```bash
./chain/localnet/torium-localnet stop
./chain/localnet/torium-localnet inspect
./chain/localnet/torium-localnet inspect --node validator-2
```

Runtime inspection copies the selected CometBFT databases into an isolated
temporary directory before opening them. GoLevelDB may write lock/log files
even for read-only queries; the copy keeps the stopped runtime byte-for-byte
unchanged and avoids host/container ownership drift on Linux.

Restore atomically and then resume:

```bash
./chain/localnet/torium-localnet restore \
  --archive "$PWD/chain/localnet/.artifacts/bug-123.tar.gz"
./chain/localnet/torium-localnet start
```

Restore always stops the whole local network first, even for a one-node
archive. It extracts into a sibling staging directory, verifies every file,
opens the staged CometBFT databases, rechecks the committed anchor, and only
then renames the declared validator homes. Any failure leaves the current homes
in place. A one-node restore never replaces another node or `topology.json`.

Export canonical Cosmos application state separately when a readable JSON bug
fixture is more useful than a restartable runtime:

```bash
./chain/localnet/torium-localnet export \
  --node validator-0 \
  --output "$PWD/chain/localnet/.artifacts/application-state.json"
```

The selected node remains stopped. The controller writes an adjacent
`.sha256` file. This JSON export is not directly restorable by the recovery
command; the `.tar.gz` snapshot is the authoritative deterministic restore
artifact.

## Recovery envelope

Every archive has an outer `<archive>.sha256` sidecar and a first-entry
`manifest.json`. Schema `torium-localnet-recovery-v1` records:

- scope and fixture recipe;
- Cosmos chain ID, EVM chain ID, and canonical genesis SHA-256;
- common committed height, block hash, and application hash;
- each node's latest height and state hashes;
- the actual `toriumd version` source/dependency identity;
- sorted file paths, modes, sizes, and SHA-256 checksums.

Restore rejects a missing or mismatched sidecar, malformed/unknown manifest
fields, absolute/traversal/backslash paths, links and device entries, duplicate
or unmanifested files, oversized input, wrong scope, wrong chain IDs or genesis,
different binary/source/dependencies, topology drift, corrupt databases, and
block/app-hash disagreement. Build timestamps are informational; protocol,
source commit, Go version, and compiled dependency identities must match.

The archive is a complete local runtime image. Cosmos SDK application snapshots
remain available through `toriumd snapshots`, but they do not include CometBFT
block/signing state and therefore are not a substitute for this local recovery
envelope. Production state-sync providers, signatures, encryption, retention,
RPO/RTO, and multi-provider trust belong to the node-recovery workstream. Validator signer custody and
monotonicity belong to the signer-custody workstream.

## Full and per-node reset

Full reset requires interactive confirmation (or explicit `--yes`) and can
only replace a directory containing the validated Torium topology marker:

```bash
./chain/localnet/torium-localnet reset
./chain/localnet/torium-localnet reset --yes # automation only
```

Reset and rejoin one validator without touching the other three:

```bash
./chain/localnet/torium-localnet reset --node validator-3
./chain/localnet/torium-localnet restart --node validator-3
```

The generator stages deterministic height-zero state, compares the current
topology byte-for-byte, requires an exact `validator-0` through `validator-3`
selector, and swaps only that real directory. A path-like node selector is
rejected. The E2E suite proves the reset node catches up to the preserved
network and observes the same contract state.

All local resets deliberately reuse `torium-localnet-1` / `0x544f524c` and
public fixture keys. Old local signatures can therefore replay when their
nonce/state again permits it. Delete stale client caches and never use these
IDs or keys on a public or valuable network. A public genesis reset must use a
new replay domain.

## Fixture recipes

Fixture names describe how the captured state was prepared; they do not bypass
normal transactions or invent application state.

### `empty`

```bash
./chain/localnet/torium-localnet reset --yes
./chain/localnet/torium-localnet start
./chain/localnet/torium-localnet snapshot --fixture empty
```

This is committed genesis state before any developer transaction. Genesis
allocations still exist, so “empty” means no post-genesis activity.

### `funded`

```bash
./chain/localnet/torium-localnet reset --yes
./chain/localnet/torium-localnet start
./chain/localnet/torium-localnet faucet 0x1111111111111111111111111111111111111111
./chain/localnet/torium-localnet snapshot --fixture funded
```

Use a disposable address. The funding transaction and receipt become part of
the normal chain history.

### `contracts-deployed`

`make -C chain/tests/e2e test` deploys and mutates `CompatibilityProbe`, creates
a `contracts-deployed` archive, changes state again, restores the archive, and
verifies code, storage, balances, and nonces. Its ignored archive is written
under `chain/tests/e2e/.artifacts/recovery-*`.

### `post-upgrade`

After a local upgrade plan has actually executed, capture the stopped network
with `snapshot --fixture post-upgrade`. The fixture type and stable envelope
are consumed by `chain/tests/governance-upgrade`, which proves a named plan was
applied before inspecting the archive's post binary profile, height, checksums,
and common state. Do not apply this label to a pre-upgrade runtime. The node-recovery workstream still
owns operator-grade public upgrade recovery.

## macOS, Linux, and containers

- Container state uses bind mounts at
  `chain/localnet/.state/container/validator-N`; `docker compose down` preserves
  it. `reset` is the cleanup command. Do not manually delete individual DB
  files or signer state.
- Docker Desktop on macOS must allow the repository path in file sharing.
  Archives remain ordinary host files; APFS copy-on-write behavior is not part
  of the checksum contract.
- On Linux, the controller normalizes ownership of container state and snapshot
  output back to the invoking UID/GID. Container snapshot/restore paths must be
  inside the repository so the pinned toolchain container can see them; use an
  ignored `.artifacts` directory. Raw-binary paths may be elsewhere.
- The raw profile uses `.state/raw`, native `build/toriumd`, and the same
  envelope. Build first with `make -C chain/app build`; stop/restart semantics
  and compatibility checks are identical.
- `.state/` and `.artifacts/` are ignored. Never commit a recovery archive,
  application export, database, validator key, or signer state.

For disk cleanup, inspect an archive first if it is needed for a bug report,
then delete the ignored archive plus sidecar. Use the controller's bounded
`reset`, not recursive commands assembled from user-provided paths.

## Verification

```bash
make -C chain/app check-container
make -C chain/localnet check
make -C chain/tests/e2e test
node chain/security/validate-threat-model-v1.mjs
```

The Go suite exercises archive round-trip, exact application data, mutation-free
database inspection, outer and inner checksums, scope/path validation,
binary/genesis/replay-domain rejection, atomic failure, and bounded per-node
reset. The clean Docker E2E exercises real balances/contract state, application
export, network restore, per-node catch-up, and corruption rejection.
