# Torium validator lifecycle (local development)

Status: executable local-only operator contract. It does not authorize a
public validator, infrastructure purchase, live value or production key use.

## Ratified local parameters

| Parameter | Value |
| --- | ---: |
| bond denomination / power reduction | `atorium` / `10^18` |
| minimum self-delegation | `1 TOR` (`10^18 atorium`) |
| active validator cap | `100` |
| unbonding time | `21 days` |
| commission min / max / daily change | `5% / 20% / 1%` |
| signed window / minimum signed | `100 / 50%` |
| downtime jail / slash | `10 minutes / 1%` |
| double-sign slash | `5%` and permanent tombstone |
| evidence age / bytes | `100,000 blocks`, `48 hours`, `1 MiB` |

Rewards come from transaction fees or TOR already present in bank accounts.
The validator lifecycle never mints native TOR.

## Before creating a validator

Use only disposable keys on the deterministic localnet. An operator needs two
different keys:

1. an account/operator key that signs staking transactions and owns the
   self-delegation;
2. an Ed25519 consensus key used by CometBFT to sign proposals and votes.

Never copy a consensus private key to a second running node. Two processes
signing at the same height can produce duplicate-vote evidence and permanently
tombstone the validator. Keep `priv_validator_key.json` and
`priv_validator_state.json` together; restoring one without the other can also
double-sign. Production backup, HSM and recovery policy remains owned by a follow-up workstream.

## Create and observe

Start the localnet and obtain the client endpoint from its status output:

```bash
./chain/localnet/torium-localnet start
./chain/localnet/torium-localnet status
```

Prepare the standard Cosmos SDK `create-validator` JSON with:

- the node's consensus public key;
- at least `1000000000000000000atorium` in both initial self-delegation and
  declared minimum self-delegation;
- commission rate at least `0.05`, maximum rate at most `0.20`, and maximum
  daily change at most `0.01`.

Submit it through the normal on-chain transaction path:

```bash
toriumd tx staking create-validator ./validator.json \
  --from <operator-key> \
  --chain-id torium-localnet-1 \
  --node http://127.0.0.1:26657
```

There is no off-chain allowlist. A valid candidate becomes active only through
the committed staking state and bonded-set ranking. Observe the result through
any stable query surface:

```bash
toriumd query staking validators --node http://127.0.0.1:26657
toriumd query staking validator <toriumvaloper-address> \
  --node http://127.0.0.1:26657
toriumd query slashing signing-info <toriumvalcons-address> \
  --node http://127.0.0.1:26657
```

REST and gRPC expose the same module state under the standard
`cosmos.staking.v1beta1`, `cosmos.distribution.v1beta1` and
`cosmos.slashing.v1beta1` services. The enabled EVM precompiles at `0x0800`,
`0x0801` and `0x0806` expose staking, distribution and slashing to contracts.
Explorers/indexers can consume the committed standard staking, distribution,
slashing, evidence and bank-burn events; they must label finality as
“CometBFT committed.”

## Delegate, redelegate and unbond

All amounts are integer `atorium`; one TOR is `10^18 atorium`:

```bash
toriumd tx staking delegate <validator> 1000000000000000000atorium \
  --from <delegator> --chain-id torium-localnet-1
toriumd tx staking redelegate <source-validator> <destination-validator> \
  1000000000000000000atorium \
  --from <delegator> --chain-id torium-localnet-1
toriumd tx staking unbond <validator> 1000000000000000000atorium \
  --from <delegator> --chain-id torium-localnet-1
```

Redelegation and unbonding are slash-aware state transitions. Unbonded tokens
become liquid only after the 21-day completion time. An operator that removes
self-delegation below its declared minimum is jailed and leaves the active set;
there is no administrator deletion or fund-seizure shortcut.

## Rewards and commission

```bash
toriumd query distribution rewards <delegator> <validator>
toriumd tx distribution withdraw-rewards <validator> --from <delegator>
toriumd tx distribution withdraw-validator-commission --from <operator-key>
toriumd tx staking edit-validator --commission-rate 0.06 \
  --from <operator-key>
```

Commission can move only once per 24-hour SDK window and cannot exceed the
validator's declared maximum/change envelope. Torium additionally rejects a
new validator whose declared envelope exceeds the local 20%/1% policy.

## Jailing and tombstoning

A validator that signs at most half of the 100-block window is slashed 1%,
jailed for ten minutes and removed from the active set. After correcting the
node and waiting for the jail duration:

```bash
toriumd tx slashing unjail --from <operator-key>
```

Duplicate-vote or light-client-attack evidence is different: attributable
double signing applies the 5% safety slash and permanently tombstones the
consensus identity. A tombstoned validator cannot unjail, even after waiting.
Do not delete evidence or edit databases to bypass that state.

## Local recovery boundary

The checked-in four-validator fixture is public, deterministic and valueless.
Use localnet reset only for disposable development state and treat a reset as a
new local history. Never reuse these account or consensus keys outside that
fixture. For a non-disposable network, stop before restore if the last signed
height is uncertain and follow the signer-custody workstream recovery contract when it is ratified.
