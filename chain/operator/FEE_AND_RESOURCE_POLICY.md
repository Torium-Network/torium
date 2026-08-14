# Torium local fee and resource policy

Status: ratified for valueless local development only. It is not a public RPC,
testnet, mainnet, throughput, or economic-security profile.

## Normative ownership

`chain/app/config/fee_economics.go` is the single runtime source for fee,
transaction, proposal, and application-mempool bounds. The exact machine
contract is `chain/config/protocol-v1.json`; `protocol-v1.schema.json`,
`validate-protocol-v1.mjs`, and `chain/app/contract_test.go` reject drift.

Runtime mapping:

| Policy surface | Runtime destination |
| -------------- | ------------------- |
| base fee, floor, denominator, elasticity, minimum gas multiplier | FeeMarket genesis and keeper parameters |
| EVM tip, price limit, replacement, slots, queues, cache, timeouts | Cosmos EVM app mempool configuration |
| 128 KiB encoded EVM transaction | upstream pool admission plus Torium EVM ante rule for proposal/execution paths |
| app-pool count, max tx bytes, proposal reap bytes/gas | Cosmos SDK and CometBFT configuration |
| block bytes/gas | generated consensus parameters |
| call gas cap | JSON-RPC configuration |

Generated local validator files are checked against this source. Do not tune a
single `app.toml`, `config.toml`, or genesis JSON by hand.

## Ratified local values

- block: 5 MiB, 30 million gas, 15 million target gas;
- transactions: 128 KiB EVM, 256 KiB Cosmos, 25 million max gas wanted;
- EIP-1559: 1 gwei initial and minimum base fee, denominator 8, elasticity 2,
  minimum gas multiplier 0.5;
- admission: 1 atorium/gas EVM minimum priority fee and pool price limit;
  validator-local Cosmos minimum gas price `0atorium`;
- replacement: both fee cap and tip cap increase by at least 10%;
- executable slots: 16 per account and 5,120 global;
- queued slots: 64 per account and 1,024 global, retained at most 3 hours;
- included-nonce cache 4,096; pending-proposal timeout 250 ms; `CheckTx`
  timeout 5 seconds; insert queue 5,000; transaction tracker disabled;
- Cosmos app pool: 1,000 transactions; Comet reap: 5 MiB and 30 million gas;
- JSON-RPC `eth_call`/estimate cap: 25 million gas.

`FeeAndResourcePolicy.Validate` fails closed on inconsistent or accidentally
public combinations.

## Fee accounting

Fees debit the sender according to gas used and effective gas price. Unused gas
is refunded. Charged base fee and priority fee enter the Cosmos fee collector
and then the distribution path; neither component is burned, so fee collection
does not change native supply. This is EIP-1559 pricing without Ethereum burn
semantics.

Only the Cosmos governance module account may change consensus FeeMarket
parameters. The local governance process is ratified and rehearsed in the
[governance and upgrade runbook](../../docs/operations/torium-chain-governance-upgrades.md).
Node-local policy changes require a
versioned, coordinated validator rollout, updated protocol/schema contracts,
generated config regeneration, and complete local acceptance evidence.

## Validation

Run before accepting a policy change:

```bash
node chain/config/validate-protocol-v1.mjs
chain/app/scripts/run-in-toolchain.sh go test -count=1 ./...
make -C chain/app genesis-check
make -C chain/tests/fees check
make -C chain/tests/fees test
```

The live fee suite proves type 0/1/2 transactions, simulation, exact fee
accounting, unchanged supply, underpriced non-retention, receiving-node-only
replacement, payload rejection and recovery, a 25,021,000-gas saturated block,
the subsequent base-fee rise, and the 1 gwei floor. Its report is written to an
ignored local artifact and must contain no secret key material.

## Failure response

1. Stop changing configuration and preserve logs, block/receipt hashes, the
   generated configs, genesis checksum, binary version, and protocol version.
2. If nodes disagree, halt the disposable localnet and do not bypass
   consensus or admission checks.
3. Classify whether the failure is admission, proposal, execution, accounting,
   propagation, RPC acknowledgement, or client lifecycle reporting.
4. Reproduce from a clean reset. Compare every generated value with
   `FeeAndResourcePolicy` and the machine contract.
5. Fix the source policy or runtime wiring, regenerate artifacts, and rerun the
   full suite. Never patch individual validator files.

Monitor block gas/bytes, base fee, rejected/evicted transactions, replacement
failures, pool depth by account, `CheckTx` latency, RPC errors/timeouts, state
growth, disk/DB latency, validator resource saturation, and proposal/commit
delay. Follow-up workstreams own public-scale thresholds, telemetry, load shedding,
recovery, and abuse evidence.

## Public activation gate

The public profile is deliberately undefined and non-activatable. These local
numbers may not be copied to a public endpoint as capacity guidance. A follow-up workstream must
approve a versioned public profile after tracked follow-up work evidence and the broader
security/release gates pass.
