# Torium node-role topology and startup runbook

## Purpose and status

This is the operator runbook for the validator, sentry, full/query, public
RPC, and private archive/indexer boundaries. It translates the
[node-role isolation decision](../decisions/2026-07-16-node-role-isolation-profiles.md)
into preflight, startup, inspection, failure, and capacity procedures.

It is a **design runbook on HOLD**, not a command to deploy. The v0 machine
definitions and offline validator exist, but the active localnet does not yet
instantiate all five roles. Generated/effective configs, runtime probes,
resource measurements, and failure drills are incomplete. Do not improvise
public listeners or apply this document to live infrastructure.

## Authority and source-of-truth order

When sources disagree, stop and resolve the mismatch in this order:

1. canonical genesis plus committed Torium chain state;
2. versioned protocol, trust, RPC, and
   [`node-roles-v0.json`](../../chain/profiles/node-roles-v0.json) machine
   contracts;
3. effective `toriumd`, CometBFT, gateway, firewall/network-policy, and indexer
   configuration;
4. this runbook and architecture prose;
5. derived PostgreSQL indexes, caches, dashboards, and presentation.

Blockscout PostgreSQL and the Torium product backend are never chain authority.
Do not repair a chain/index mismatch by editing product tables, explorer balances,
indexed hashes, receipts, or logs.

## Environment mapping

| Logical boundary  | Local equivalent required before role-topology closure                            | Future infrastructure unit                                |
| ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Public edge       | loopback-published gateway and sentry ports on isolated networks         | public load balancer/WAF and internet P2P security groups |
| Consensus private | separate validator homes/processes reachable only from sentry network    | validator hosts plus isolated signer/custody boundary     |
| Query private     | non-validator full, public-RPC upstream, and archive homes/processes     | independently scalable query/archive hosts and volumes    |
| Indexer private   | Blockscout backend/database reachable only from archive and presentation | isolated indexer/application/database subnets             |
| Operations        | local operator identity and isolated telemetry network                   | bastion/VPN/service identity plus metrics/log platform    |

Local containers or raw processes may share a workstation only to test policy.
They must not share node homes, keys, volumes, process namespaces, or unrestricted
networks. Every user-facing local publish remains `127.0.0.1`.

The inactive v0 local-equivalence reservation is collision-free: validator
publishes P2P/Comet on `26656/26657`; sentry P2P on `27056`; full/query
P2P/Comet/EVM HTTP/EVM WS/REST/gRPC on
`27156/27157/18545/18546/11317/19090`; public RPC P2P/EVM HTTP/EVM WS on
`27256/28545/28546`; archive/indexer P2P on `27356`; and the separate archive
policy gateway HTTP/WS on `38545/38546`. All numeric publications are loopback.
The archive node's raw EVM ports have no host publication and exist only on the
`archive-raw-rpc` network shared with its gateway sidecar. Blockscout joins only
`archive-indexer-consumer`. The reservation does not activate the topology,
except for the archive/indexer role and its gateway, which ARE activated
locally — see "Local archive lane" below.

Public RPC v0 is EVM-only. Keep public Cosmos REST and gRPC disabled until the Cosmos-interface publication follow-up
defines and proves their compatibility and stability contract.

## Local archive lane (activated 2026-07-30)

The archive/indexer role and its policy gateway are the one part of this
topology with a running local equivalent:

```bash
make -C chain/localnet archive-up      # prepare + start both services
make -C chain/localnet archive-status
make -C chain/localnet archive-down
make -C chain/localnet reset-archive   # height-zero archive fixture

./chain/profiles/run-archive-gateway-evidence-v0.sh   # the evidence lane
```

- `torium-localnet --archive` generates a `private-archive-indexer` home beside
  the four validators, with `pruning = "nothing"` from genesis, the kv
  transaction index, **no** CometBFT RPC listener, and no Cosmos REST/gRPC. It
  writes `archive-topology.json`; the four-validator `topology.json` is
  unchanged.
- `chain/profiles/compose.archive-gateway.yaml` is an **overlay** on
  `chain/localnet/compose.yaml`, so the four-validator localnet is identical
  whether or not the archive lane runs.
- `torium-archive-gateway` is the only member of both `archive-raw-rpc`
  (`internal: true`) and `archive-indexer-consumer`. It enforces
  `candidateMethodContract`, refuses a batch whole if any member is forbidden,
  and restricts `eth_subscribe` to `newHeads`/`logs`.
- Its `/metrics` endpoint exports
  `torium_archive_gateway_requests_total{outcome="forwarded"|"refused"|"upstream_failed"}`.

**Operational caveat:** `make -C chain/localnet up` and `down` pass
`--remove-orphans`, which removes the archive services. Re-run `archive-up`
after restarting the localnet.

The archive node also joins `consensus` for p2p, because the localnet
instantiates neither the `sentry` nor the `full` role that the contract's
`persistentPeerRoles` prefers. The contract's claim is that consumers cannot
reach the raw RPC, and consumers live on `archive-indexer-consumer`; that is
what the evidence proves.

## Profile inventory

Create and review one inventory row per process before startup:

| Field        | Required record                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| identity     | environment, role, instance ID, operator, region/failure domain when applicable                                     |
| artifacts    | Torium binary/image digest, profile version, genesis checksum, Cosmos and EVM chain IDs                             |
| storage      | node home, application DB, block retention, pruning mode/parameters, tx indexer, free-space threshold               |
| P2P          | node ID, listen/advertise address, persistent/private peers, PEX, seed/address-book policy, inbound/outbound limits |
| clients      | enabled HTTP/WS/REST/gRPC/Comet surfaces, exact listener addresses, proxy chain, method and origin policy           |
| secrets      | required key/credential classes, forbidden classes, mount paths, owner, permissions, rotation reference             |
| dependencies | sentries, signer, gateway, archive, Blockscout, PostgreSQL, telemetry, time and DNS                                 |
| limits       | bodies, batches, ranges, results, connections, timeouts, concurrency, rates, WS sessions                            |
| readiness    | sync/height/hash/peer checks, earliest supported height, lag and resource thresholds                                |

An unset value is not an upstream-default approval. Mark it `HOLD`, assign an
owner, and keep the process unready.

The machine contract names reusable Comet diagnostic, Cosmos query, EVM client,
and storage policies. Schema validation proves their shape and cross-role
references only. Before startup, render every field into the pinned upstream
configuration and compare the effective config; a named policy is not runtime
conformance evidence.

## Key and secret preflight

For every home, image, volume, environment, and configured key path:

1. Reject symlinks or shared volumes that cross role boundaries.
2. Require a unique P2P node key owned by the process user.
3. For validators only, verify the expected consensus public identity and one
   monotonic signer-state location. Never copy or regenerate signer state during
   an ordinary restart.
4. A sentry, full/query, public RPC, or archive/indexer may have its own
   auto-generated disposable FilePV pair if CometBFT requires it. Derive its
   public key and compare it against both genesis and the current validator set;
   fail on any match. Repeat this test after validator-set changes.
5. Fail a non-validator role if it contains a copied registered validator-set
   key/state, remote-signer credential/configuration, or another role's FilePV.
   Keep every unregistered FilePV private, file-mode restricted, unique to one
   home, disposable, and ineligible for validator admission.
6. Fail every chain node if it contains a faucet, user, deployer, governance,
   Blockscout, PostgreSQL, TLS private key, mnemonic, or unrelated raw account
   private key.
7. Keep gateway TLS/service credentials, Blockscout application secrets,
   PostgreSQL credentials, and telemetry credentials in their owning services.
8. Run the prohibited-secret scanner against the exact generated staging tree
   before packaging diagnostics. Never print a matched secret.

The committed deterministic local consensus keys are public fixtures. Their
presence proves only local reproducibility and is an automatic rejection in a
future environment.

## Network and peer preflight

### Validator

- Listen on P2P `26656` only in the consensus-private network.
- Use named sentries as the only persistent/private peers.
- Disable PEX and external address advertisement; never put validator IPs in a
  public seed, address book, DNS record, explorer, or support bundle.
- Keep Comet RPC loopback/off and every EVM/REST/gRPC/profiling surface off.

### Sentry

- Publish only P2P `26656` to external chain peers.
- Maintain at least two diverse validator-to-sentry paths in future planning;
  the exact sentry count, peer limits, seed set, and diversity threshold are
  HOLD until tracked follow-up work.
- Bound inbound/outbound connections and file descriptors. Do not solve peer
  starvation by unbounding the process.
- Keep client RPC and consensus signing absent.

### Full/query, public RPC, and archive/indexer

- Peer through sentries; do not add a direct validator route as a recovery
  shortcut.
- Bind base service ports only in the query-private network.
- Publish public RPC solely through gateway `443`; do not publish `8545`, `8546`,
  `1317`, `9090`, or `26657` directly.
- Permit the indexer to reach only the private archive policy-gateway identity
  on `archive-indexer-consumer`. Permit only that gateway to reach raw archive
  EVM on `archive-raw-rpc`; reject every direct indexer/operator-to-raw path.
- Permit telemetry scraping on the observability network only. Profiling is off
  unless a time-bounded incident procedure explicitly enables a private target;
  it is never a readiness dependency.

## RPC, method, and origin preflight

1. Materialize the role's consumer method contract in the required policy
   gateway. Cosmos EVM and CometBFT native namespace/unsafe switches are not
   per-method enforcement. Reject a namespace-only policy, a bypass path, or a
   profile whose `gatewayActivated`/`effectiveConformanceProven` evidence is
   false.
2. For validators, sentries, and public RPC, prove `debug`, `admin`, `personal`,
   `miner`, profiling, insecure unlock, unprotected transactions, and direct
   txpool access are absent/denied.
3. For archive/indexer v0, assert its independent candidate contract is
   read-only, excludes `eth_sendRawTransaction`, keeps `requiredStandardMethods`
   empty until archive/indexer reconciliation, keeps `requiredTraceMethods` empty, and
   leaves all four PoC-proven trace methods disabled.
4. Verify Blockscout has
   `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true`. If it is false or
   absent, keep Blockscout stopped/unready.
5. Probe each allowed standard method at the intended role and each forbidden
   method at every role. Record status/error class without credentials or
   request bodies containing secrets.
6. For browser WebSocket, compare the finite gateway and upstream HTTPS-origin
   sets byte-for-byte. Reject `*`, arbitrary reflection, or a hidden permissive
   default. An unknown browser origin must fail closed.
7. Test non-browser/private service identity separately; do not add a wildcard
   to make a service probe pass.
8. Confirm reconnect and HTTP backfill behavior is owned by the client and does
   not depend on subscription replay.

The v0 method/origin definitions are machine-readable. Generated/effective
runtime enforcement and role-specific conformance output remain HOLD. Do not
publish based only on offline validation or the current loopback profile.

## Pruning, indexing, and history preflight

Record independently:

- Cosmos application pruning strategy and interval/keep-recent values;
- CometBFT block retention;
- transaction indexer mode;
- earliest queryable block and historical state height;
- receipt/log range support;
- snapshot/state-sync and archive rebuild source;
- database growth, compaction, free space, and estimated time to exhaustion.

Then apply the role rule:

- **Validator:** sufficient for consensus, evidence, upgrade, and recovery; no
  public historical-query promise.
- **Sentry:** no history promise; pruning must not break safe catch-up or the
  required P2P/evidence behavior.
- **Full/query and public RPC:** publish a bounded, tested history/state window
  and fail clearly outside it.
- **Archive/indexer:** retain all history required by the archive rebuild contract,
  currently targeted from genesis. Prove the earliest height, block/hash,
  transaction/receipt/log, and balance-bearing queries before ready.

If the configured history is shorter than the declared window, fail readiness.
Never silently proxy a pruned request to a validator, product backend, or public
third-party RPC.

## Startup order and readiness

The intended dependency order is:

1. validate immutable artifacts, genesis, profiles, homes, secrets, networks,
   storage, and time prerequisites;
2. start validator signer boundaries and validators without public clients;
3. start sentries and verify only the expected private validator paths;
4. start non-validator full/query, public-RPC upstream, and archive/indexer nodes;
5. start the public gateway only after RPC negative/positive conformance passes;
6. start PostgreSQL and Blockscout only after archive reconciliation passes;
7. start presentation only after Blockscout lag/canonical checks and the archive-reconciliation
   legal/presentation gates pass.

Readiness must report at least artifact/profile identity, chain IDs, sync state,
consensus and EVM heights, canonical comparison height/hash, peer count/diversity,
earliest supported height, current listener set, policy version, disk headroom,
and indexer lag where applicable.

Use these states consistently:

| State       | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `booting`   | process/dependency startup has not completed                                       |
| `syncing`   | identity and policy pass, canonical height is catching up                          |
| `ready`     | every role-specific positive and negative gate passes                              |
| `degraded`  | bounded service remains safe but a redundancy/SLO signal is impaired               |
| `unhealthy` | identity, policy, history, canonicality, signer, disk, or dependency safety failed |

Never report ready because a TCP port opened.

## Capacity review and scaling

For a representative Torium workload, preserve a time-bounded report containing:

- request/transaction mix and data range;
- CPU, RSS, disk usage/growth, IOPS/latency, network ingress/egress, open files
  and connections;
- sync/catch-up/rebuild duration and peak resource use;
- per-method p50/p95/p99 latency, timeout/error/shedding rate, body/batch/range
  rejection, and WS sessions;
- consensus propagation, round, vote, and commit latency;
- Blockscout canonical/index lag and PostgreSQL growth/restore duration; and
- thresholds, observation duration, artifact/profile versions, and raw evidence
  location.

Scaling rules:

- add public RPC nodes behind the gateway only after each independently syncs
  and passes identity/policy tests;
- scale sentry paths for diversity and P2P saturation, not to mask validator
  exposure;
- scale archive storage/IOPS or add a separately verified archive replica before
  the rebuild/free-space window is breached;
- never scale consensus by cloning a validator home or signer key; and
- shed public/indexer load before consensus health is affected.

All numeric supported envelopes are HOLD until a follow-up workstream records them.
The numeric values in `node-roles-v0.json` are planning floors, not supported
capacity or purchase guidance.

## Failure matrix

| Failure                                                                           | Immediate response                                                              | Recovery boundary                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| registered validator-set key/state or remote signer appears outside its validator | keep role stopped; quarantine host/volume and investigate exposure              | rotate/recover under tracked follow-up work; never delete evidence or copy signer state casually       |
| validator has public/admin/profiling listener                                     | remove from network/readiness immediately                                       | correct generated/effective config and rerun negative probes before restart               |
| wildcard or unknown WS origin succeeds                                            | close gateway/upstream WS path                                                  | restore finite lists and prove allowed plus denied origins                                |
| public RPC exposes debug/txpool/admin                                             | remove affected node from gateway                                               | rebuild from approved profile; review logs for abuse without exposing payload secrets     |
| sentry loss isolates validator                                                    | keep validator private; accept degraded/halted connectivity                     | restore/replace sentry path; never open validator P2P to the internet as a shortcut       |
| public RPC overload                                                               | shed/rate-limit public traffic and mark degraded                                | add independently validated RPC capacity; consensus remains isolated                      |
| archive becomes pruned/corrupt or disk-full                                       | stop indexer writes/serving stale data; preserve diagnostics                    | restore verified archive or rebuild; reconcile canonical height/hash and earliest history |
| Blockscout falls behind or diverges                                               | mark presentation stale/unavailable                                             | refetch only on same canonical history or discard derived DB and reindex per the archive-reconciliation contract         |
| product backend and chain view disagree                                           | treat chain/RPC as authority; do not edit chain or explorer from product tables | repair the product adapter separately if it is ever introduced                            |
| profile, genesis, chain ID, or binary mismatch                                    | fail startup                                                                    | deploy the intended immutable artifact; no forced join or silent migration                |
| resource threshold breached                                                       | mark degraded/unhealthy and shed non-consensus load                             | scale within the role boundary, then repeat measurements                                  |

## Evidence required to remove HOLD

The node-role exposure contract can leave HOLD only when one immutable local evidence bundle records:

- offline-validated v0 definitions plus generated runtime profiles for every
  role;
- generated and effective config comparisons;
- exact listener, route/firewall, method, and origin allowlists;
- positive required-call and negative forbidden-call/origin probes;
- proof that every non-validator FilePV public key is absent from genesis/current
  validator membership and no registered key/state or remote signer crosses its
  validator boundary;
- local sentry isolation and forbidden cross-zone connectivity;
- pruning/indexing/history behavior at boundary heights;
- archive/indexer canonical reconciliation with internal transactions
  disabled and zero debug requirements (the archive RPC target itself is now
  activated and gateway-enforced locally; the Blockscout-side reconciliation
  against it is still open under the explorer follow-up);
- resource/catch-up/rebuild measurements or explicit linked holds; and
- failure-drill outputs with no public or live deployment.

Until then, use the current loopback-only localnet for development and describe
the five-role topology only as planned local/public architecture.

## Related documents

- [Node-role isolation ADR](../decisions/2026-07-16-node-role-isolation-profiles.md)
- [Machine-readable node-role contract](../../chain/profiles/node-roles-v0.json)
- [Offline node-role validator](../../chain/profiles/validate-node-roles-v0.mjs)
- [Archive gateway activation record](../changes/2026-07-30-archive-gateway-activation.md)
- [Archive lane compose overlay](../../chain/profiles/compose.archive-gateway.yaml)
- [Archive gateway evidence runner](../../chain/profiles/run-archive-gateway-evidence-v0.sh)
- [Torium EVM L1 protocol](../architecture/torium-evm-l1-protocol-v1.md)
- [Validator trust and finality model](../architecture/torium-validator-trust-finality-v1.md)
- [Blockscout local compatibility decision](../decisions/2026-07-16-blockscout-local-explorer-stack.md)
- [Chain threat model](../security/torium-chain-threat-model-v1.md)
- [Governance and upgrade runbook](./torium-chain-governance-upgrades.md)
