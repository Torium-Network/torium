# Torium local chain resilience foundation v0

A follow-up workstream owns the local finality and recovery behavior matrix. This directory
defines what each scenario must prove and how a future result is recorded. It
does not stop nodes, change networks, fill disks, alter clocks, corrupt state or
send traffic.

The plan copies all 11 stable `chaos.*` IDs and their exact liveness/safety
strings from `chain/config/trust-model-v1.json`. Plan-owned finality and recovery
expectations are separate fields so the trust model is not silently rewritten.

Run the offline contract check with:

```bash
node chain/resilience/validate-resilience-plan-v0.mjs --committed-results
node --test chain/resilience/validate-resilience-result-v0.test.mjs
```

The validator checks source-version drift, exact scenario mapping, evidence
paths, HOLD status and future report semantics. If
`chain/resilience/results/*.result.json` exists, it also verifies each report and
the SHA-256 of every referenced repo-relative artifact. No result is committed
by this foundation.

This v0 accepts only release-blocked `fail`, `unsafe` or `invalid` executed
evidence. A `pass` is deliberately rejected until a scenario-specific runner
can prove the fault phase and complete per-height/node coverage. Extension
scenario reports are likewise disabled until their mappings are implemented.

## Existing evidence is not full scenario proof

- One-node stop/rejoin, quorum loss, full restart, recovery and upgrade tests
  provide partial functional evidence.
- Validator lifecycle/evidence behavior has module-level evidence.
- RPC reconnect/backfill is partial dependency evidence.
- Partitions, bounded delay, disk/database failures, isolated dependency loss,
  state sync, hard crash and proposer omission have no current runtime report.

Existing tests are not rerun by this issue. A scenario stays unexecuted until a
dedicated local runner produces a complete report.

## Fail-closed result boundary

A future executed report must carry non-placeholder identifiers and hashes, exact
expected strings, a baseline/change/recovery timeline, per-node committed state,
operator decisions and a contradictory-commit audit. Manual state edits are
invalid. A contradictory committed state is `unsafe` and release-blocking; later
recovery cannot downgrade it. The 50-power Byzantine assumption-violation case
can never provide an affirmative safety guarantee or a passing release result.

Public/remote systems, live deployment, the Torium product backend, bridges,
L2s and infrastructure purchasing are outside this local contract.

## Proposer censorship: the fault surface had to be built (2026-07-29 → 2026-07-30)

`local-proposer-censorship` was the last canonical scenario without an
implemented fault module. Three configuration-level injection routes were tried
against the real stack first, and each one failed for a concrete reason:

1. **Disable the application mempool on one validator**
   (`app.toml [mempool] max-txs = -1`). No effect on proposals: with a NoOp
   application mempool, cosmos-sdk's default proposal handler forwards the
   transactions CometBFT supplies
   (`baseapp/abci_utils.go` `PrepareProposalHandler`). Verified by a run where
   the censoring proposer still included transactions.
2. **Disable the CometBFT mempool on one validator**
   (`config.toml [mempool] type = "nop"`). The node refuses to start:
   cosmos-evm requires both switches to agree and reports
   `EVM mempool enabled, but comet-bft has invalid config.toml:mempool.type
   (want 'app', got 'nop')`. Setting `max-txs = -1` alongside it does not
   satisfy the guard either, because the effective application mempool size
   comes from the node's own `InitAppConfig` policy rather than the file.
3. **Withhold transaction gossip from the node that receives transactions**
   (`config.toml [mempool] broadcast = false` on validator-0). Other proposers
   still included the transactions, so the transactions reach them by another
   path; with an app-side mempool `/num_unconfirmed_txs` is always `0` on every
   node, so CometBFT-level mempool inspection cannot be used to confirm what
   propagated.

### The implemented surface (2026-07-30)

`chain/app/censorfixture` is a **build-tag-gated censoring `PrepareProposal`
fixture**. It is the only code in this repository that can make a Torium
proposer omit transactions, and the guarantee is compile-time absence rather
than a runtime switch:

- `enabled.go` is `//go:build toriumcensorfixture`; `disabled.go` is
  `//go:build !toriumcensorfixture` and makes `Wrap` the identity function.
- `Enabled` is a compile-time constant, asserted `false` by
  `boundary_test.go` in the default build — including with the runtime switch
  set to its most aggressive value.
- No release artifact passes the tag: the Dockerfile only receives it through
  `ARG GO_BUILD_TAGS=""`, the release bundle script never mentions it, and the
  app Makefile mentions it only in the dedicated `container-censor-fixture`
  target.
- The drill itself greps both **built images**: the release image must not
  contain the fixture's log string, and the fixture image must. That is the
  proof that survives a validator being wrong.

The fixture matches transactions by a hex fragment in their raw bytes
(`TORIUM_CENSOR_PREPARE_PROPOSAL=hex:<fragment>`), or drops everything with
`=all`. An unrecognized value **panics at startup** rather than running as a
no-op, because a drill that believes it is censoring when it is not produces a
false negative.

One encoding detail cost time: the drill marks its transactions with 32 random
bytes in the EVM **call data**, not by recipient address. `data` is a protobuf
`bytes` field, so the marker appears as contiguous raw bytes in the Cosmos
transaction the proposal handler sees; cosmos-evm encodes `to` as an ASCII hex
string, so a recipient-address needle would not match the transaction bytes.

The drill replaces exactly one validator (25% of power, matching the scenario's
`byzantinePower`) and asserts a decisive invariant: **no marked transaction
appears in any block the censoring validator proposed**, while every marked
transaction is still eventually included by an honest proposer. It fails closed
if the censoring validator never took a proposer turn, if it recorded no drops,
or if the fixture never reported itself active — each of those would make the
observation a false negative rather than a pass.
