# Torium Cosmos EVM baseline proof

This directory is the reproducible upstream-baseline decision spike. It
boots the exact Cosmos EVM v0.7.0 source, applies the minimum two local
compatibility corrections, and exercises the RPC, wallet, mempool, explorer,
and Solidity toolchain behavior that later Torium work is allowed to promise.

It is not Torium's production chain, a Torium backend integration, a bridge, or
an Ethereum L2. All accounts, passwords, mnemonics, keys, chain IDs, images,
and databases here are disposable local fixtures. Never reuse them on a public
network.

## Selected baseline

- Cosmos EVM `v0.7.0` at commit
  `f4ab9a3e3fbe353468327d5cacda94b33b41ed11`
- Cosmos SDK `v0.54.3`
- CometBFT `v0.39.3`
- Cosmos `go-ethereum` replacement `v1.17.2-cosmos-0`
- Go `1.25.9`
- Four validators, Cosmos chain ID `local-4221`, EVM chain ID `262144`
- CometBFT app-side mempool

Those two chain IDs are historical PoC fixtures, not Torium network metadata.
A later identifier audit found that EIP-155 ID `262144` is registered to MPCQ
Mainnet. All canonical localnet/devnet/testnet/mainnet consumers must use
[`chain/config/identifiers.json`](../../config/identifiers.json).

The complete immutable inputs are in [pins.json](./pins.json). Tested behavior
and its downstream constraints are in
[support-matrix.json](./support-matrix.json). The architecture reasoning lives
in
the recorded Cosmos EVM baseline selection.

## Prerequisites

- Docker Desktop or Docker Engine with Compose v2
- Git and curl
- Node.js 22 or newer and npm
- At least 8 GiB of free memory for the source builds and four validators
- Optional: jq and unzip for Blockscout and MetaMask workflows

The first Cosmos EVM and Blockscout image builds are intentionally slow. No
VPS, cloud service, Torium backend, or public RPC is used.

## Boot from a clean checkout

From this directory:

```bash
./scripts/bootstrap-localnet.sh
npm ci
REPORT_PATH=./proof/rpc-compatibility.json npm run probe
```

The bootstrap script clones the exact commit under ignored `.work/`, verifies
it, builds the pinned image, creates four fresh validator homes, changes only
the generated mempool mode from `flood` to `app`, and waits for JSON-RPC.

Expected endpoints:

| Validator |                HTTP RPC |         WebSocket RPC |
| --------- | ----------------------: | --------------------: |
| node0     | `http://127.0.0.1:8545` | `ws://127.0.0.1:8546` |
| node1     | `http://127.0.0.1:8555` | `ws://127.0.0.1:8556` |
| node2     | `http://127.0.0.1:8565` | `ws://127.0.0.1:8566` |
| node3     | `http://127.0.0.1:8575` | `ws://127.0.0.1:8576` |

Stop only this managed localnet with:

```bash
./scripts/stop-localnet.sh
```

## Compatibility probes

The standard probe verifies viem and ethers connectivity, a signed transfer,
contract deployment, fee history and its 100-block cap, block tags, all four
required debug trace methods, and WebSocket subscriptions. It also records the
known browser-Origin rejection instead of masking it.

```bash
REPORT_PATH=./proof/rpc-compatibility.json npm run probe
```

The upstream reference genesis uses unlimited consensus block gas. Exercise a
deliberately saturated block on a separate, disposable PoC profile with:

```bash
TORIUM_POC_MAX_BLOCK_GAS=42000 ./scripts/bootstrap-localnet.sh
REPORT_PATH=./proof/fee-history-saturation.json \
  npm run probe:fee-history-saturation
```

This keeps the exact binary and app-side mempool pin, admits two 21,000-gas
transfers into one block, and requires `eth_feeHistory` to report
`gasUsedRatio: 1`. The 42,000 value is a test fixture, not Torium's production
block-gas decision; a follow-up workstream still owns that value and its economic/load tests.

The resilience probe restarts `evmdnode0`. It verifies that the socket closes,
HTTP recovers, a new subscription receives a head, and the client can backfill
missed heights over HTTP.

```bash
REPORT_PATH=./proof/websocket-resilience.json npm run probe:resilience
```

The mempool probe deliberately stops two validators to halt quorum. It tests
underpriced and higher-fee same-nonce submissions, nonce gaps, cross-validator
visibility, capacity/eviction, and mining after quorum resumes. Its `finally`
path restarts the stopped validators.

```bash
REPORT_PATH=./proof/mempool.json npm run probe:mempool
```

The result is intentionally `partial` for Ethereum-style replacement: the
receiving validator replaces the transaction, but the replacement is not
guaranteed to propagate across validators. A follow-up workstream must expose this as a
capability and lifecycle outcome, not promise network-wide RBF.

## Hardhat and Foundry

Compile the Solidity probe and connect through Hardhat 3:

```bash
npx hardhat compile
REPORT_PATH=./proof/hardhat.json node hardhat-probe.mjs
```

Run Foundry without installing it on the host:

```bash
docker run --rm --network host \
  --entrypoint cast \
  ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd \
  chain-id --rpc-url http://127.0.0.1:8545
```

The committed proof also includes a signed `cast send` result using the public,
disposable upstream test fixture. Do not put a real private key in shell
history or this repository.

## MetaMask

Download and verify the exact Chrome extension archive:

```bash
./scripts/download-metamask.sh
```

The automated browser probe requires a visible Chromium session and the
public 24-word `dev0` fixture embedded by upstream in `testnet.go`. Supply it
only through the environment; the report never records it.

```bash
METAMASK_EXTENSION_PATH="$PWD/.work/metamask-chrome-13.39.2" \
METAMASK_VERSION=13.39.2 \
TORIUM_DEV_MNEMONIC='<upstream dev0 fixture; never a real wallet>' \
REPORT_PATH="$PWD/proof/metamask.json" \
SCREENSHOT_PATH="$PWD/proof/metamask-custom-network.png" \
npm run probe:metamask
```

This creates a fresh browser profile unless `REUSE_METAMASK_PROFILE=1` is
explicitly set. Success means the extension added `0x40000`, exposed the
expected fixture account, showed Torium PoC as the selected network, approved a
1-wei transfer, and observed a successful receipt.

The same pinned browser driver is parameterized for the canonical Torium
localnet by `chain/tests/tooling/run-metamask.sh`. That conformance runner supplies the
canonical chain metadata, funds a newly imported disposable account through
the loopback faucet, and keeps its report and screenshot under ignored local
artifacts. The defaults in this directory remain the exact historical PoC.

## Blockscout

Blockscout v11.2.2 has no usable public image tag for this exact release in the
tested registry path, so build the exact source commit locally:

```bash
./scripts/build-blockscout.sh
docker compose -p torium-blockscout-baseline -f blockscout-compose.yml up -d
curl --fail http://127.0.0.1:44000/api/v2/stats
```

Run the fresh-index, restart-persistence, controlled-reindex, and raw trace
envelope proof together with:

```bash
REPORT_PATH="$PWD/proof/blockscout.json" ./scripts/probe-blockscout.sh
```

The supported profile disables only the internal-transaction fetcher. To
reproduce the incompatibility on a disposable database:

```bash
BLOCKSCOUT_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=false \
docker compose -p torium-blockscout-baseline -f blockscout-compose.yml up -d
docker compose -p torium-blockscout-baseline -f blockscout-compose.yml logs backend
```

Cosmos EVM returns result-only entries from `debug_traceBlockByNumber`, while
Blockscout v11.2.2 expects each entry to contain `txHash` and `result`. The
fetcher raises `FunctionClauseError`. Base block and transaction indexing,
restart persistence, and controlled block refetch all passed with
`INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true`; internal transactions
remain blocked on a follow-up adapter/upstream decision.

The v11.2.2 source uses a custom `LicenseRef-Blockscout` license effective
2026-04-22. Legal review is required before production selection or
distribution.

## Known limitations that downstream work must preserve

- EIP-155 ID `262144` collides with MPCQ Mainnet and is retained only so these
  proof artifacts describe their exact run. Never expose it as a Torium chain.
- `safe` works for `eth_getBlockByNumber` but fails with JSON-RPC `-32602` for
  balance, nonce, and `eth_call` state queries.
- `pending` responds, but distinct geth-equivalent pending-state semantics were
  not proven.
- `finalized` is a Cosmos EVM/CometBFT view, not Ethereum beacon finality.
- Browser-origin WebSockets return HTTP 403 with the upstream reference
  allowlist. A follow-up workstream must add an explicit origin allowlist in the correct
  profile, never a blanket production wildcard.
- Subscription reconnect and missed-height backfill are client
  responsibilities.
- The reference genesis has unlimited consensus block gas and an EVM gas limit
  of `0xffffffff`. The bounded 42,000-gas PoC saturation test passed, but the economics workstream
  must re-test the real production value and economics.
- Same-nonce replacement is local-node behavior, not a network-wide guarantee.
- RPC acceptance does not guarantee mempool retention.
- Blockscout internal transactions are disabled pending a separately tested
  fix.
- Torium-specific Cosmos REST/gRPC APIs do not exist yet and need an explicit
  versioned contract in the Cosmos-interface publication follow-up.
- IBC, ICS precompiles, bridges, Torium backend integration, public deployment,
  and L2 behavior are out of scope.

## Proof artifacts

`proof/` contains machine-generated JSON summaries and the MetaMask screenshot
from exact pinned runs. Transaction hashes and disposable addresses are
public local evidence; no credential or recovery phrase is stored there.
