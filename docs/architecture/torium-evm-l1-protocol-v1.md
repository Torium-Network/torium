# Torium EVM L1 protocol and network specification v1

Status: local-development contract (`1.0.0-local.5`), accepted 2026-07-15.

Torium is a sovereign Cosmos EVM L1 using CometBFT consensus. It is not an
Ethereum L2, rollup or Ethereum-settled network. This specification authorizes
only a locally runnable chain. Testnet and mainnet names are reserved inputs,
not live networks, token promises or deployment approval.

The normative machine source is
[`chain/config/protocol-v1.json`](../../chain/config/protocol-v1.json). Network
identifiers come from
[`chain/config/identifiers.json`](../../chain/config/identifiers.json), and
tested compatibility cannot exceed the
[`support-matrix.json`](../../chain/poc/upstream-baseline/support-matrix.json)
without new evidence.

## 1. Implementation baseline

| Component                      | Normative version                                           |
| ------------------------------ | ----------------------------------------------------------- |
| Cosmos EVM                     | `v0.7.0`, commit `f4ab9a3e3fbe353468327d5cacda94b33b41ed11` |
| Cosmos SDK                     | `v0.54.3`                                                   |
| CometBFT                       | `v0.39.3`                                                   |
| Cosmos go-ethereum replacement | `v1.17.2-cosmos-0`                                          |
| Go                             | `1.25.9`                                                    |

The exact toolchain lives in `chain/toolchain.json`. Torium owns app
composition, genesis, parameters, compatibility tests and operational
profiles; upstream owns the consensus, SDK, EVM and cryptographic
implementations unless a later ADR authorizes a maintained fork.

## 2. Network and replay domains

| Environment | Cosmos chain ID     |   EIP-155 ID | Hex          | Currency       | State                          |
| ----------- | ------------------- | -----------: | ------------ | -------------- | ------------------------------ |
| localnet    | `torium-localnet-1` | `1414484556` | `0x544f524c` | valueless tTOR | active locally                 |
| devnet      | `torium-devnet-1`   | `1414484548` | `0x544f5244` | valueless tTOR | private, inactive              |
| testnet     | `torium-testnet-1`  | `1414484564` | `0x544f5254` | valueless tTOR | public name reserved, inactive |
| mainnet     | `torium-1`          |    `5525330` | `0x544f52`   | TOR            | public name reserved, inactive |

All EVM transactions require EIP-155 chain-ID replay protection. Unprotected
transactions are rejected. Cosmos transactions require their chain ID and
account sequence with `SIGN_MODE_DIRECT`; legacy Amino JSON signing is not a
stable v1 contract.

A deterministic localnet reset deliberately reuses a valueless local replay
domain. If balances and sequences reset too, an old local signed transaction
can replay. Reset tooling must delete transaction artifacts and users must
clear the wallet's local activity. A public genesis is different: after any
abandoned/reset public genesis, both Cosmos and EIP-155 IDs must change and the
old IDs can never be reused.

The IDs were collision-checked on the recorded date but are not public-registry
reservations. A follow-up workstream must recheck immediately before any approved registry
submission.

## 3. Accounts and addresses

Torium EVM accounts use secp256k1, SLIP-44 coin type `60` and the default path
`m/44'/60'/0'/0/0`. The EVM address is the final 20 bytes of the Keccak-256
hash of the uncompressed public key without its `0x04` prefix.

An EVM address and a Torium Bech32 account address are two encodings of the
same 20 bytes. There is no lookup table, custodial mapping or bridge:

```text
20 account bytes
  ├─ 0x hex (EVM JSON-RPC, wallets, contracts)
  └─ Bech32 with torium HRP (Cosmos REST/gRPC and CLI)
```

- JSON-RPC uses a 20-byte `0x` hex value.
- SDK and user-facing docs emit EIP-55 checksummed hex.
- Equality compares normalized 20-byte values, never case-sensitive strings.
- Cosmos REST/gRPC may return Bech32. Conversion must validate HRP, checksum
  and exactly 20 decoded bytes.
- Contract, module and validator/consensus addresses are role-specific and
  must not be accepted as account addresses only because they decode.

| Role                             | Prefix                               |
| -------------------------------- | ------------------------------------ |
| account / public key             | `torium` / `toriumpub`               |
| validator operator / public key  | `toriumvaloper` / `toriumvaloperpub` |
| validator consensus / public key | `toriumvalcons` / `toriumvalconspub` |

Normative account vectors:

| EIP-55 hex                                   | Torium Bech32                                   |
| -------------------------------------------- | ----------------------------------------------- |
| `0x0000000000000000000000000000000000000000` | `torium1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmhxxp0` |
| `0x52908400098527886E0F7030069857D2E4169EE7` | `torium122gggqqfs5ncsms0wqcqdxzh6tjpd8h8qzqrsf` |
| `0x000000000000000000000000000000000000dEaD` | `torium1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dan4mxl` |
| `0x00112233445566778899AABbCCdDeeFf00112233` | `torium1qqgjyv6y24n80zye42aueh0wluqpzg3nn2jt40` |

The machine manifest also includes validator-operator and validator-consensus
encodings for all four byte vectors. The executable validator recalculates and
decodes every role. Exact upstream `evmd debug addr` commands with the
`torium`, `toriumvaloper`, and `toriumvalcons` prefixes independently produced
the committed values during review.

## 4. Native asset and monetary rules

The native balance has one canonical ledger: Cosmos `x/bank`, exposed to the
EVM as native value and through a canonical ERC-20/WETH-compatible Solidity
facade. The facade is not a deployed or wrapped token and does not create a
second balance or supply.

| Property                | Value                                  |
| ----------------------- | -------------------------------------- |
| base denomination       | `atorium`                              |
| display denomination    | `TOR`; `tTOR` on non-value networks    |
| decimals                | `18`                                   |
| one display unit        | `1,000,000,000,000,000,000 atorium`    |
| staking power reduction | `1,000,000,000,000,000,000`            |
| localnet genesis supply | `1,000,000,000 tTOR` (`10^27 atorium`) |
| mint module / inflation | omitted / `0`                          |
| issuance model          | genesis-capped, non-inflationary       |
| Solidity facade         | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` |

Power reduction is deliberately `10^18`: one whole TOR/tTOR maps to one
integer CometBFT voting-power unit. The generated localnet rejects validator
stakes that truncate to zero, requires whole-power genesis delegations, and
tests stakes immediately below, at, and above one power unit. Its four
validators self-delegate 25 tTOR each and produce `25/25/25/25` power after the
real application `InitChain`.

The validator-lifecycle contract ratifies the executable local lifecycle values: a 1 TOR minimum
self-delegation, 100 active-validator cap, 21-day unbonding time, 5–20%
commission with 1% maximum daily movement, 2% community tax, a 100-block/50%
availability threshold, 10-minute/1% downtime jail and slash, and a 5%
double-sign slash plus permanent tombstone. Evidence is bounded to 100,000
blocks, 48 hours and 1 MiB per block. Rewards redistribute fees or existing
bank balances and never mint TOR. These values are local-only; public economics
remain blocked by the owner launch-approval gate and require a fresh review.

Creation, delegation, redelegation, unbonding, reward/commission withdrawal,
jailing, unjailing and duplicate-vote tombstoning are exercised against the
real keepers. Boundary operations at `1`, `10^18-1`, `10^18`, `10^18+1` and a
large stake reconcile bank supply, staking pools, shares, rewards, burns and
integer power. Operator commands and key-safety boundaries are in the
[validator lifecycle guide](../../chain/operator/VALIDATOR_LIFECYCLE.md).

Localnet supply is genesis-capped and valueless. The reviewed fixture allocates
1,000 tTOR to each validator, 900,000,000 tTOR to the loopback faucet fixture,
50,000,000 tTOR to the deployer, 25,000,000 tTOR to the SDK user, and
24,996,000 tTOR to the test user. Each of the four signed genesis validator
transactions pays `250,000,000,000,000 atorium` for 250,000 gas at the 1 gwei
floor. `InitChain` therefore moves 100 tTOR into the bonded pool and a total of
`1,000,000,000,000,000 atorium` into the fee collector while supply remains
exactly 1 billion tTOR.
After `InitChain`, the bank keeper rejects every attempt by any module to mint
`atorium`, including the otherwise mint-capable EVM and ERC-20 module accounts.
Protocol-authorized module burns may permanently reduce supply and must remain
visible through committed bank events and the total-supply query. This is why
the precise model is genesis-capped and non-inflationary rather than an
unconditional claim that supply can never decrease.

The native facade's `balanceOf` and `totalSupply` read the same bank balance and
supply used by `address.balance`, gas, CLI/REST/gRPC, staking, governance and
distribution. ERC-20 `transfer` moves `atorium` directly. `deposit` returns the
caller's `msg.value` and emits a compatibility event; `withdraw` validates the
native balance and emits a compatibility event without moving funds. Neither
operation wraps, mints, burns, or converts TOR. Permissionless registration and
native representation conversion are disabled.

No public genesis amount or allocation is defined or publishable. It remains
an explicit external product input to the approved public-genesis/deployment
gate under owner launch approval; the local 1 billion tTOR fixture is never a mainnet default.
Adding native minting or inflation, changing frozen supply/allocation, changing
the canonical facade, or changing fee burn/distribution is a breaking economic
change.

The rationale and compatibility consequences are recorded in the
[canonical native TOR asset ADR](../decisions/2026-07-15-canonical-native-tor-asset.md).
Contract integrations use the committed
[`IToriumNative` interface](../../contracts/interfaces/README.md), and the
[implementation note](../changes/2026-07-15-canonical-native-tor-asset.md)
lists the executable evidence and affected surfaces.

## 5. Consensus, blocks and finality

Torium uses unmodified CometBFT `v0.39.3`. The target block interval is
2 seconds. The initial hard limits are:

| Limit                  |               Value |
| ---------------------- | ------------------: |
| block bytes            | `5,242,880` (5 MiB) |
| block gas              |        `30,000,000` |
| EIP-1559 target gas    |        `15,000,000` |
| one EVM transaction    | `131,072` (128 KiB) |
| one Cosmos transaction | `262,144` (256 KiB) |
| transaction gas wanted |        `25,000,000` |

A block becomes committed when CometBFT obtains the required greater-than-two-
thirds voting power. The SDK default is one committed block; this is
deterministic CometBFT commit semantics, not Ethereum beacon-chain finality.
The JSON-RPC `finalized` label maps to the latest committed CometBFT state.
`safe` is not a supported state-query guarantee because the baseline rejected
it for balance, nonce and `eth_call` even though block lookup accepted it.

These rules do not mean history is metaphysically impossible to change: a
greater-than-one-third Byzantine fault can halt liveness, and unsafe operator
restores or a greater-than-two-thirds safety failure violate the trust model.
A follow-up workstream owns validator authority, fault assumptions, timeouts and the exact
public claims.

## 6. Fees

EIP-1559 pricing is active from height 1:

| Parameter                   |                                Value |
| --------------------------- | -----------------------------------: |
| initial/minimum base fee    | `1,000,000,000 atorium/gas` (1 gwei) |
| base-fee change denominator |                                  `8` |
| elasticity multiplier       |                                  `2` |
| minimum gas multiplier      |                                `0.5` |
| minimum EVM priority fee    |                 `1 atorium/gas` |
| validator extra minimum gas |                    `0atorium` |

The block target is `maxGas / elasticityMultiplier`, or 15 million gas. Above-
target blocks raise the next base fee and below-target blocks lower it by the
standard EIP-1559 proportional rule using denominator 8; the 1 gwei floor is
never crossed. The EVM pool additionally rejects a tip below 1 atorium/gas.
That pool rule is distinct from the validator-local Cosmos minimum gas price,
which remains `0atorium` for deterministic local tooling.

Charged fees enter the Cosmos fee collector and then the distribution path.
The base fee is not burned, unused gas is refunded, and fee collection does not
change native supply. Torium therefore claims EIP-1559 pricing, not Ethereum's
burn economics. Keeper tests reconcile sender debit, fee-collector credit,
refunds, and unchanged supply; the four-validator acceptance suite proves the
floor plus a base-fee rise after a 25,021,000-gas block.

Only the Cosmos governance module account may change consensus FeeMarket
parameters. A follow-up workstream ratifies and exercises that local proposal/upgrade process;
the public authority remains undefined. Node-local fee,
mempool, or resource-limit changes require a versioned, coordinated rollout
and fresh compatibility evidence. These are local-development values, not a
public economic-security or throughput claim. A public profile is undefined
and cannot activate until the owner launch-approval gate approves it with capacity and
abuse evidence from tracked follow-up work.

## 7. EVM transaction and execution contract

Accepted public EVM envelopes:

- type 0: legacy plus EIP-155 replay protection;
- type 1: EIP-2718/EIP-2930 access list;
- type 2: EIP-2718/EIP-1559 dynamic fee.

Type 3 blob transactions are rejected because Torium has no Ethereum blob/data-
availability layer or blob fee market. Upstream implements type 4 set-code
transactions, but Torium disables them at admission until a separate EIP-7702
security decision and the conformance gate. Compiler execution targets Prague;
that does not silently opt Torium into every Ethereum consensus-layer feature.

Contract creation and calls are permissionless. No upstream example preinstall
or token pair is allowed at genesis. The sole token pair is the canonical
bank-backed native facade; it is not a wrapped asset. A follow-up workstream owns the
explicit system-contract deployment model and registry.

## 8. Module and precompile composition

Included modules:

`auth`, `bank`, `consensus`, `distribution`, `erc20`, `evidence`, `evm`,
`feemarket`, `genutil`, `gov`, `slashing`, `staking`, `upgrade`.

`evm` is the module manager and genesis key exposed by upstream Cosmos EVM's
`x/vm` Go package. The executable name is used here so the protocol manifest
can be compared directly with the running module manager.

Explicitly excluded modules:

`authz`, `circuit`, `feegrant`, `ibc`, `ibc-transfer`, `mint`, `vesting`.

The `erc20` module starts with exactly one module-owned native token pair at
`0xEeee...EEeE`, ERC-20 support enabled, permissionless registration disabled,
no dynamic precompile, and no upstream example pair. It exposes the bank-backed
native facade described above. Governance authority remains subject to
the trust-model and governance contracts; inclusion is not permission for an undocumented operator key to
mutate parameters or create a competing canonical representation.

Active custom precompiles:

| Address                                      | Surface           |
| -------------------------------------------- | ----------------- |
| `0x0000000000000000000000000000000000000100` | P-256             |
| `0x0000000000000000000000000000000000000400` | Bech32 conversion |
| `0x0000000000000000000000000000000000000800` | staking           |
| `0x0000000000000000000000000000000000000801` | distribution      |
| `0x0000000000000000000000000000000000000804` | bank              |
| `0x0000000000000000000000000000000000000805` | governance        |
| `0x0000000000000000000000000000000000000806` | slashing          |

Standard Prague EVM precompiles also remain active. Every Cosmos extension is
part of the security and conformance scope; a module being included does not
bypass its normal authorization rules.

### IBC and bridge decision

IBC is omitted from Torium v1 runtime composition. IBC-Go may remain a
transitive upstream source dependency, but the Torium app has no IBC store,
keeper, genesis section, message route, transfer module, channel, relayer or UX.
ICS20 (`0x...0802`) and ICS02 (`0x...0807`) precompiles are inactive. Genesis
validation and module-composition tests must prove that state. Future bridge or
IBC work requires a separate approved design, threat model, audit and protocol
upgrade; Cosmos ancestry is not approval to expose it.

## 9. App mempool

CometBFT must use `mempool.type = "app"`. The app-side EVM pool starts with:

| Parameter                               |                    Value |
| --------------------------------------- | -----------------------: |
| minimum priority / pool price limit     |          `1 atorium/gas` |
| same-nonce price bump                   |                      10% |
| executable slots per account / global   |             16 / 5,120 |
| queued slots per account / global       |             64 / 1,024 |
| queued lifetime                         | 10,800 seconds (3 hours) |
| included-nonce cache                    |                    4,096 |
| pending proposal / `CheckTx` timeout    |       250 ms / 5 seconds |
| insert queue                            |       5,000 transactions |
| Cosmos app-pool maximum                 |       1,000 transactions |
| EVM / Cosmos maximum encoded tx         |      128 KiB / 256 KiB |
| Comet proposal reap bytes / gas         |  5 MiB / 30,000,000 gas |
| transaction tracker                     |                 disabled |

A same-nonce replacement must increase both fee cap and tip cap by at least
10%. The four-validator acceptance test halts consensus, rejects 9%, accepts
exactly 10%, and limits the claim to the receiving node. JSON-RPC may return a
transaction hash before asynchronous `CheckTx`; RPC acceptance is therefore
not a retention or proposal promise. Replacement is not guaranteed network-
wide, and SDK lifecycle APIs must expose dropped/replaced/unknown states rather
than promise Ethereum-style RBF.

The local abuse envelope is explicit:

| Input or pressure | Local behavior / evidence |
| ----------------- | ------------------------- |
| fee cap below current base fee | may receive an RPC hash but is not retained or proposed |
| encoded EVM tx above 128 KiB | rejected; a signed 125 KiB transaction commits |
| encoded Cosmos tx above 256 KiB | rejected by Comet/app admission bounds |
| RPC body above 5 MiB or batch above 100 | rejected by the adjacent RPC acceptance suite |
| block execution pressure | six test-only out-of-gas calls produce a 25,021,000-gas block under the 30M ceiling; the next base fee rises |
| persistent state growth | a 20,000-gas new-slot lower bound gives at most 750 theoretical slots at target and 1,500 at max gas before transaction, call, and cold-access overhead |

The slot arithmetic is only a conservative gas-model lower bound. Sustained
state growth remains unbounded over time, no public capacity is claimed, and
the performance-baseline and public-hardening workstreams must benchmark storage, execution, propagation, recovery, telemetry,
and public abuse controls before the owner launch-approval gate can activate any public profile. The
[fee and resource policy guide](../../chain/operator/FEE_AND_RESOURCE_POLICY.md)
owns local configuration mapping and failure response.

## 10. Interfaces, limits and ports

Default JSON-RPC namespaces are `eth`, `net` and `web3`. `debug` and `txpool`
are operator-profile surfaces; `miner` and `personal` are disabled. A public
profile must never inherit debug/trace exposure merely because a local explorer
needs it. Insecure account unlock is disabled in every profile.

| RPC limit                           |                  Value |
| ----------------------------------- | ---------------------: |
| `eth_call`/estimate gas cap         |             25,000,000 |
| `eth_call` timeout                  |              5 seconds |
| `eth_feeHistory` blocks             |                    100 |
| `eth_getLogs` results / block range |        10,000 / 10,000 |
| HTTP body                           |                  5 MiB |
| batch requests / response           | 100 / 25,000,000 bytes |

Browser WebSocket wildcard origins are forbidden. Clients own reconnect and
HTTP backfill because subscriptions do not replay missed messages.

| Service                    |             Base port |
| -------------------------- | --------------------: |
| REST                       |                  1317 |
| pprof                      |                  6060 |
| JSON-RPC metrics           |                  6065 |
| geth metrics               |                  8100 |
| JSON-RPC HTTP / WebSocket  |           8545 / 8546 |
| gRPC / gRPC-Web            |           9090 / 9091 |
| P2P                        |                 26656 |
| Comet RPC / ABCI / metrics | 26657 / 26658 / 26660 |

Multi-node local orchestration adds `nodeIndex × 100` to base host ports.
Services may bind all interfaces inside an isolated container network, but host
publishing is loopback-only. No local configuration falls back to a public
endpoint. A follow-up workstream owns validator/sentry/RPC/archive exposure profiles.

## 11. Genesis, versioning and compatibility

Genesis format version is `1`; the canonical local artifact is generated JSON
plus SHA-256 under `chain/genesis/localnet`. Its sole reviewed input is
`chain/app/localnet/fixture.json` plus the application module defaults. Clean
regeneration, the public manifest, `toriumd genesis validate-genesis`, checksum
verification, and real `InitChain` reconciliation are release checks. The
configuration namespace is `torium.chain.v1`. A public genesis freeze records
the protocol version, identifier manifest version, binary and dependency
versions, genesis checksum, module/precompile set and compatibility matrix.

The specification uses semantic versioning:

- clarification with no behavior change, additive disabled client capability,
  and consensus-preserving fixes are non-breaking;
- state transition, consensus, chain ID, address derivation, denomination,
  decimals, power reduction, module, precompile, accepted transaction type,
  stable API semantics, fee disposition or frozen supply/allocation changes are
  breaking.

A breaking change needs a new spec version, owner issue, migration/upgrade
handler, local upgrade rehearsal, conformance matrix, compatibility manifest
and release notes. Public chains use a versioned on-chain upgrade for compatible
state migrations. A reset/new genesis uses new replay-domain IDs.

## 12. Ownership and assertion map

| Surface                                         | Owner issue | Executable assertion           |
| ----------------------------------------------- | ----------: | ------------------------------ |
| identifiers and collision state                 | tracked follow-up work | `validate-identifiers.mjs`     |
| protocol constants and address vectors          |         the protocol-constants gate | `validate-protocol-v1.mjs`     |
| authority, finality claims and validator faults |         the trust-model definition | trust model and resilience scenarios |
| threat invariants and secret controls           |         the security-invariant gate | security gates and scans       |
| deterministic supply/allocations/power          |         the economics workstream | generated-genesis tests        |
| module/precompile composition                   |         the module-composition tests | app wiring and genesis tests   |
| validator lifecycle                             |        the validator-lifecycle contract | lifecycle/invariant tests      |
| native asset                                    |        the native-asset gate | bank/EVM/Solidity conservation and mint-denial tests |
| fees and anti-spam                              |        the fee-policy evidence | policy/runtime contract tests plus `chain/tests/fees` |
| governance and upgrades                         |        the local governance process | `validate-governance-v1.mjs` plus `chain/tests/governance-upgrade` |
| EVM/RPC conformance                             |        the conformance workstream | compatibility suite            |
| endpoint exposure                               |        the node-role exposure contract | profile/security tests         |

No value in this document authorizes Torium backend/mobile integration, a
bridge, infrastructure purchase, public deployment, token sale or mainnet
launch.
