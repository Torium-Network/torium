# Torium local performance foundation v0

A follow-up workstream owns this local-only contract for future transaction, RPC, state
growth and resource baselines. It defines reproducible workload identities,
result provenance and a strict machine-readable result shape without claiming
that a benchmark has already happened.

## What exists

- `performance-v0.json` defines three bounded smoke workloads for the canonical
  four-validator combined localnet and lists every deferred workload explicitly.
- `capacity-result-v0.schema.json` requires host, Git, toolchain, binary,
  genesis, effective-config and workload provenance for a future real result,
  plus block/finality, RPC, resource, state-growth, bottleneck, failure-cliff
  and content-hashed artifact fields.
- `summarize-samples.mjs` deterministically summarizes already-collected local
  samples. Inclusion is recorded separately from execution outcome, committed
  reverts count toward included throughput, and acknowledgement/inclusion/
  receipt latency stay separate. The tool derives elapsed time from start/end
  timestamps; it does not connect to a node or generate traffic.
- `validate-performance-v0.mjs` checks schema validity and prevents configured
  protocol/RPC limits or planning resource floors from becoming capacity claims.

Run the lightweight checks with:

```bash
node chain/performance/validate-performance-v0.mjs
node --test chain/performance/summarize-samples.test.mjs
```

Execute the three active workloads against an already-running localnet with
the controlled runner (three repetitions are committed under `results/`):

```bash
node chain/performance/run-local-baselines.mjs --workload all [--label repN]
```

A result file is schema- and semantics-checked by passing it as the
optional argument: `node chain/performance/validate-performance-v0.mjs result.json`.
The validator reconciles outcome/TPS/RPC counts, distinguishes HTTP requests
from JSON-RPC calls, checks ordered summaries and rejects placeholder
`complete-local` evidence.

Committed reports use `chain/performance/results/*.result.json`. CI discovers
them automatically with `--committed-results`, validates plan/workload identity,
and verifies that every referenced repo-relative artifact exists and matches
its declared SHA-256. A complete transaction or RPC report must include its
matching `raw-transaction-samples` or `raw-rpc-samples` artifact plus a
`resource-samples` artifact. No result is committed in this foundation PR.

These checks are intentionally synthetic and offline. Do not repeatedly run the
chain, MetaMask, RPC or full E2E suites when neither the implementation nor the
environment changed.

## HOLD boundary

No public/safe TPS, QPS, role sizing, VPS sizing, bill of materials, IOPS,
database growth, indexer lag, failure cliff or CI regression threshold is
claimed. The committed results are exploratory local baselines from a Docker
Desktop VM (three repetitions per workload, raw artifacts preserved); they are
not an operating envelope, and capacity claims stay null/false until a pinned
reference host and a review turn a number into one.

Public endpoints, remote systems, production services, the Torium product
backend, bridges, L2s and deployment are outside this contract.
