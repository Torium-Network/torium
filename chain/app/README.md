# Torium sovereign EVM L1 application

This Go module builds `toriumd`, the standalone Torium protocol-v1 node. It is
an independent state machine based on the exact Cosmos EVM v0.7.0 baseline; it
does not import or call the Torium product backend, Clerk, PostgreSQL, or Redis.

Status: local development only. The binary is not a public network, public RPC,
mainnet, testnet, bridge, or existing Torium product integration.

## Runtime composition

The executable wires only these Cosmos SDK/Cosmos EVM modules:

`auth`, `bank`, `consensus`, `distribution`, `erc20`, `evidence`, `evm`,
`feemarket`, `genutil`, `gov`, `slashing`, `staking`, `upgrade`.

IBC, IBC transfer, mint, vesting, authz, circuit, and feegrant are not runtime
modules. The ERC-20 module starts with exactly one pair: the canonical
bank-backed native facade at `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.
It creates no wrapped balance or second supply. Permissionless ERC-20
registration and dynamic precompiles are disabled. Only the seven static custom
precompiles listed in `chain/config/protocol-v1.json` are enabled; ICS-20 and
ICS-02 precompiles are absent. EIP-4844 blob and EIP-7702 set-code transactions
are rejected at admission.

The local identity is:

- Cosmos chain ID: `torium-localnet-1`
- EVM chain ID: `1414484556` (`0x544f524c`)
- base denomination: `atorium` (18 decimals)
- local display denomination: `tTOR`
- native Solidity facade: `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`
- Bech32 account prefix: `torium`
- HD path: `m/44'/60'/0'/0/0`

`toriumd tx` exposes generic signing/encoding plus bank, staking, distribution,
slashing, governance, and EVM groups using the application's real
account/validator address codecs. `toriumd query` exposes bank, staking,
distribution, slashing, and governance AutoCLI groups from the
exact Cosmos SDK v0.54 module descriptors without instantiating a second state
machine. Workflows are in
[`chain/localnet/ACCOUNTS.md`](../localnet/ACCOUNTS.md).

## Deterministic development commands

Go 1.25.9 is required exactly. When it is not installed on the host, use the
digest-pinned container (the canonical path):

```bash
cd chain/app
make check-container
```

With native Go 1.25.9 and a C toolchain:

```bash
make check       # format/tidy/generate/test/vet/build/version contract
make lint-container # pinned golangci-lint static analysis
make build       # writes toriumd, torium-genesis, torium-localnet and torium-faucet
./build/toriumd version
```

The localnet genesis is generated from `localnet/fixture.json` plus the real
module defaults. Never hand-edit the generated files:

```bash
make genesis        # replace chain/genesis/localnet public artifacts
make genesis-check  # fail if clean regeneration differs
./build/toriumd genesis validate-genesis ../genesis/localnet/genesis.json
```

The fixture creates four equal 25-power validators and four development
accounts. Its account and validator material is publicly reproducible,
disposable, valueless, and forbidden for any public or valuable network. The
committed genesis and manifest contain addresses, public keys, transactions,
signatures and checksums only; they contain no secret signing material.

`atorium` is genesis-capped and non-inflationary. The app-level bank mint
restriction denies post-genesis native minting even to generic EVM module
accounts with minter permission. Authorized bank burns remain supply-reducing
and observable. The local fixture is valueless; no public genesis supply or
allocation is defined. Solidity integrations use the canonical
[`IToriumNative` interface](../../contracts/interfaces/README.md); its address
and behavior are part of the protocol contract rather than a separately
deployed token.

Cosmos EVM's secp256k1 implementation requires CGO. Linux builds run in the
pinned Alpine builder. macOS builds must run natively with Go 1.25.9 and Xcode
Command Line Tools; `CGO_ENABLED=0` cross-builds are intentionally unsupported.

Build and inspect the non-root Linux container from `chain/app`:

```bash
make container
docker run --rm toriumd:local version
```

Four-validator orchestration is documented in
[`chain/localnet/README.md`](../localnet/README.md). It derives runtime-only
keys into ignored state, runs the exact canonical genesis, and contacts no
public endpoint.

The complete create/delegate/redelegate/unbond/reward/jail/tombstone operator
flow and its local-only economics are documented in
[`chain/operator/VALIDATOR_LIFECYCLE.md`](../operator/VALIDATOR_LIFECYCLE.md).
The EIP-1559, gas, transaction, proposal, mempool, accounting, tuning, and
failure-response contract is documented in the
[`fee and resource policy guide`](../operator/FEE_AND_RESOURCE_POLICY.md).
Local governance authority, immutable binary profiles, named software upgrade,
checksum preflight, failed-migration recovery, and four-validator rehearsal are
documented in the
[`governance and upgrade runbook`](../../docs/operations/torium-chain-governance-upgrades.md).

## Contract tests

`contract_test.go` instantiates the app and compares its runtime module set,
precompiles, genesis defaults, identity, staking power reduction, fee market,
and replay-domain validation with the normative protocol JSON. `ante_test.go`
pins type-4 rejection. `boundary_test.go` fails if standalone code imports or
configures the existing Torium product stack. `localnet/generator_test.go`
regenerates canonical files byte-for-byte, tests the stake immediately below,
at, and above one power unit, and runs the complete genesis through the real
application `InitChain` to reconcile supply, pools, tokens, shares and voting
power, proves the ERC-20 module registers only the native facade, and denies
native minting without balance, supply, or event mutation.
`localnet/validator_lifecycle_test.go` proves on-chain admission/removal,
delegation, redelegation, unbonding, exact rewards and commission, bounded
18-decimal dust, downtime jail/unjail and duplicate-vote tombstoning.
`config/fee_economics_test.go` rejects inconsistent policy combinations;
`localnet/fee_economics_test.go` proves base-fee math, fee-collector accounting,
unchanged supply, and governance-only FeeMarket updates. The live canonical
four-validator acceptance lives in `chain/tests/fees` and proves envelope,
replacement, payload, saturation, accounting, and base-fee behavior.
`upgrades_test.go` pins strict plan metadata, migration and module-map digests,
profile wiring, and executable SHA-256. `chain/tests/governance-upgrade` proves
authority, quorum, exact-height halt, rollback/no-commit, partial-validator
resume, late catch-up, and EVM/Cosmos state preservation.
`localnet/runtime_test.go` pins separate validator identities, peer and
port profiles, hardened configs, restart preservation, drift rejection and
explicit deterministic reset.
