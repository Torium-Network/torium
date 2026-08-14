# Torium chain configuration contracts

`identifiers.json` is the only source that chain, SDK, release metadata, and
developer documentation may copy public Torium identifiers from. The manifest
is prelaunch metadata: it does not create a public network, publish a package,
configure DNS, or reserve an external account by itself.

Validate the manifest and its dated availability audit from the repository
root:

```bash
node chain/config/validate-identifiers.mjs
node chain/config/validate-protocol-v1.mjs
node chain/config/validate-trust-model-v1.mjs
node chain/config/validate-rpc-profile-v1.mjs
node chain/config/validate-faucet-policy-v1.mjs
node chain/config/validate-governance-v1.mjs
node chain/config/validate-sdk-policy-v0.mjs
```

`protocol-v1.json` is the machine-readable protocol contract for accounts,
native asset rules, consensus/finality semantics, gas and payload limits,
transaction envelopes, module/precompile composition, mempool behavior, RPC
limits, ports, environment activation and breaking-change policy. Its
structural schema is `protocol-v1.schema.json`; semantic and cross-manifest
assertions live in `validate-protocol-v1.mjs`.

The strict `validatorEconomics` section pins the local staking, commission,
distribution, slashing, evidence and 18-decimal accounting contract ratified
by the validator-lifecycle contract. It is active only for the valueless local protocol; its embedded launch-approval
gate keeps public activation false and requires a fresh genesis review.

The native-asset section defines `atorium` as the one 18-decimal bank ledger
for EVM value/gas, staking, governance, rewards, RPC, wallet, explorer, SDK and
Solidity consumers. Its canonical Solidity address is
`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`; that precompile is a direct
bank-backed facade, not wrapped supply. Post-genesis native minting and
permissionless representation registration are disabled. The public genesis
amount remains null and unpublishable until an explicitly approved launch gate.

`trust-model-v1.json` is the machine-readable authority, validator, quorum,
finality, lifecycle, fault-scenario and public-messaging contract. Its
structural schema is `trust-model-v1.schema.json`; semantic assertions and
cross-checks against the protocol/toolchain live in
`validate-trust-model-v1.mjs`. The four-validator localnet is one authority
domain and must never be described as decentralized. The seven-independent-
operator public-testnet topology is an inactive readiness target, not a live
network claim.

The trust contract distinguishes the validator-lifecycle contract's locally ratified lifecycle values and
the locally ratified governance authority from the still-unratified light-client
trusting period and every public authority decision. Local ratification does
not clear the public topology, key-custody, fee-load, security-review or launch
gates.

The same trust contract records the exact local-only consensus timeouts used by
all four runtime nodes. Their `active-local-unratified` status means they are
deterministic development inputs, not public-network guarantees. A follow-up workstream
must measure them under load and a follow-up workstream must supply fault evidence before their
status can change.

`rpc-profile-v1.json` is the active local-only interface and exposure contract.
It pins the validator-0 client surface, JSON-RPC namespaces and limits, REST and
gRPC resource bounds, Comet diagnostic endpoints, WebSocket reconnect/backfill
semantics, wallet metadata and health states. Its validator cross-checks the
protocol and identifier manifests and rejects any non-loopback Compose host
publication. This is not a public node profile. The node-role exposure contract's machine-readable role
contract defines isolated validator, sentry, full, public-RPC, and private
archive/indexer targets, but their runtime activation and effective conformance
remain on hold. A follow-up workstream owns later public hardening, while a follow-up workstream owns any future
Torium-specific Cosmos REST/gRPC stability promise. The v0 explorer requires no
`debug_trace*` method.
Implementation and compatibility notes are preserved in the
[local endpoint change record](../../docs/changes/2026-07-14-local-endpoint-contract.md).

`faucet-policy-v1.json` is the active valueless local faucet contract. It pins
loopback exposure, chain/denom identity, request and rolling address limits,
HTTP bounds, memory-only disposable signing, secret-free API/log invariants,
and the explicit public-faucet boundary. Its validator cross-checks the
identifier/protocol manifests, genesis signer inventory, and Compose host
publication. The workflow is in
[`chain/localnet/ACCOUNTS.md`](../localnet/ACCOUNTS.md).

`governance-v1.json` is the ratified local-only governance, module-authority,
software-upgrade and failure-recovery contract. It fixes the 3-of-4 equal-
validator quorum behavior, denies direct privileged messages and hidden admin
keys, names the `torium-local-v1` migration, and defines the immutable `pre`,
`post`, and `failed-rehearsal` binary profiles. Its validator cross-checks
genesis parameters, source authority wiring, the protocol/trust/security
contracts, and the four-validator fixture. Public authority and rollback policy
remain deliberately undefined behind the owner launch-approval gate. The operator procedure is in the
[governance and upgrade runbook](../../docs/operations/torium-chain-governance-upgrades.md).

`sdk-policy-v0.json` is the local-first, unpublished SDK architecture contract.
It pins `@torium-network/sdk` as a small viem extension, defines public module
and account boundaries, records compatibility/versioning rules, and sets
executable export and bundle budgets. Browser and React Native are named but
unverified targets until the runtime-verification follow-up; the selected Node 22/24 LTS range also remains a
candidate until that runtime matrix passes. Publication to npm remains blocked
on the npm-release gate.

## Canonical prelaunch values

| Environment | EIP-155 decimal | Hex          | Cosmos chain ID     | Currency |
| ----------- | --------------: | ------------ | ------------------- | -------- |
| Localnet    |      1414484556 | `0x544f524c` | `torium-localnet-1` | tTOR     |
| Devnet      |      1414484548 | `0x544f5244` | `torium-devnet-1`   | tTOR     |
| Testnet     |      1414484564 | `0x544f5254` | `torium-testnet-1`  | tTOR     |
| Mainnet     |         5525330 | `0x544f52`   | `torium-1`          | TOR      |

The local/dev/test IDs encode `TORL`/`TORD`/`TORT` and the main ID encodes
`TOR` in hex.
All are below signed 32-bit maximum for conservative tool compatibility.
EIP-3085 wallet metadata is generated from these rows. Only localnet has
default endpoints (`127.0.0.1:8545` and `127.0.0.1:8546`); public RPC,
explorer, and icon fields stay empty/deferred so clients cannot silently fall
back to an invented hosted service.

The `262144` / `0x40000` value used by the upstream PoC is explicitly
noncanonical: it is already registered to MPCQ Mainnet. Historical proof files
keep it so the experiment stays auditable, but tracked follow-up work, wallet
metadata, and examples must use this manifest instead.

## Reservation status

- Chain IDs were clear in the pinned Chainlist snapshot, but public mainnet and
  testnet IDs are not globally reserved. Chainlist assigns a chain ID to the
  first accepted PR. Recheck immediately before registration; registration
  waits for approved public RPC/explorer metadata.
- `@torium-network/sdk` returned package-not-found, but the npm organization
  cannot be verified or claimed from this unauthenticated host. An authorized
  owner must create it with MFA and a second owner. `torium-evm-sdk` is the
  checked fallback.
- The `torium-network` GitHub organization was not found. An authorized owner
  must create it with MFA and two owners. `Torium-Network/torium` is the canonical repository URL.
- `https://torium.network/docs` is the canonical future documentation path.
  It and `docs.torium.network` intentionally remain unpublished.
- TOR has known ticker collisions. It stays the working product symbol without
  exclusivity claims; public-value/listing work requires brand/legal review.
  TRIUM is a fallback, not a second live symbol.

The dated evidence and required owner follow-ups are in
`identifier-availability.json`. Architecture and change-control reasoning are
in the
canonical identifier selection.

## Change control

Changing a chain ID, Cosmos chain ID, Bech32 prefix, base denomination,
currency symbol, package scope, or canonical docs path is a compatibility
event. Update the identifier and protocol manifests, availability audit,
schemas/validators, release artifacts, SDK chain definitions, the npm release
plan, and user-facing docs in one reviewed change. Never silently
reuse a public chain ID or change only one representation.
