# Torium local fee and resource acceptance

This suite proves the ratified local-only EIP-1559 and anti-spam contract on
the canonical four-validator Torium network. It does not publish an endpoint,
contact the Torium product backend, authorize a public fee profile, or make a
mainnet-capacity claim.

Run it from a clean checkout:

```bash
make -C chain/tests/fees test
```

The command resets disposable local state, starts the four-validator network,
and stops it on success or failure. It uses Node.js for orchestration, the
digest-pinned Foundry container from `chain/toolchain.json` for ordinary
signing, and a deterministic Go helper for large signed payloads that cannot
fit through a shell argument list.

One run proves:

1. `eth_estimateGas` and `eth_call` simulation work for a funded local account.
2. EIP-155 protected type 0, EIP-2930 type 1, and EIP-1559 type 2 envelopes
   commit and report the expected receipt types.
3. A type-0 transaction signed for a different EIP-155 chain ID and an
   unprotected legacy transaction are both rejected without consuming the next
   canonical nonce.
4. Blob type 3 and EIP-7702 set-code type 4 are rejected, matching the
   protocol's explicit exclusion of Ethereum blob data availability and
   delegated-code transactions.
5. Sender debit equals value plus `gasUsed × effectiveGasPrice`, recipient
   credit equals value, and fee processing does not change native supply.
6. A fee cap below the current base fee is not retained or proposed. The RPC
   may acknowledge a hash before asynchronous `CheckTx`; that ACK is not a
   retention promise and the pending nonce must not advance.
7. With consensus deliberately halted, a 9% same-nonce bump is rejected and an
   exact 10% bump of both fee cap and tip cap replaces the transaction at the
   receiving node. The test deliberately makes no network-wide RBF promise.
8. An admitted nonce-gap transaction leaves the committed nonce unchanged.
   Pending-nonce and by-hash observations are recorded but never treated as
   execution eligibility because this profile does not expose a geth-equivalent
   synthetic pending state. Filling the gap causes both transactions to commit
   in nonce order after consensus resumes.
9. One valid 125 KiB transaction commits while an encoded transaction above
   128 KiB is rejected. Separately, six small calls to a test-only four-byte
   infinite-loop runtime consume deterministic out-of-gas fees and, together
   with the three preceding nonce-chain transfers, fill the 30 million gas
   block exactly without state growth.
10. The following block raises the base fee and subsequent blocks never fall
    below the 1 gwei protocol floor.
11. After the chain has at least 100 historical blocks, `eth_feeHistory` returns
    exactly 100 entries at the configured boundary, rejects 101 with the
    expected cap error, and reports the saturated block's gas-used ratio,
    reward-percentile shape and current/next base fees.

## Deliberate evidence boundaries

This is EVM L1 fee-market and mempool compatibility acceptance. Same-nonce
replacement is proved only on the receiving node because CometBFT gossip does
not provide a network-wide Ethereum RBF guarantee. SDK documentation must
preserve that distinction.

The protocol config fixes executable/queued account capacity at 16/64 and
global capacity at 5120/1024. A raw transaction RPC acknowledgement is
asynchronous and does not prove retention, while the default endpoint keeps
`txpool` disabled. Consequently the live harness cannot observe an exact
capacity boundary without changing the product surface. The proof report marks
that boundary `not-observable-from-default-profile`; config validation and
keeper/unit evidence remain authoritative for those four limits.

RPC body/batch rejection is exercised by the adjacent `chain/tests/rpc`
acceptance suite. Revert charging and contract deployment are exercised by
`chain/tests/e2e`. Keeper-level tests independently prove fee collector credit,
no supply burn, base-fee boundary math, invalid policy rejection, and
governance-only fee parameter changes.

The ignored `.artifacts/latest-report.json` records the most recent proof. It
contains public local fixture identifiers and results only, never private or
validator key material. Failure diagnostics redact signer arguments and matching
subprocess output even though the suite key is a deterministic valueless fixture.
