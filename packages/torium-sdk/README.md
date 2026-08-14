# Torium TypeScript SDK

Local-first TypeScript SDK foundation for the Torium sovereign EVM L1. The
package is intentionally private and unpublished while the v0 surface is built
and verified.

## Status

The dual ESM/CommonJS package, declarations, strict exports, tarball checks, and
API drift guard are implemented. Canonical Torium chain definitions and
endpoint identity/readiness guards are available under the `./chains` subpath.
The `./clients` subpath extends a standard viem public client with Torium
network status and versioned capability metadata while leaving ordinary EVM
reads on viem's typed surface. The `./utils` subpath provides bigint-only native
amounts, environment-aware currency metadata, EIP-55/`torium1` account
conversion, primitive validation, and tagged bigint JSON. Shared typed errors,
explicit read retry/timeout/cancellation controls, and redacted diagnostics are
available under `./errors`. Generated contract clients remain planned follow-up work. The
`./wallet` subpath now provides the first EIP-1559 preflight, one-shot submission
and CometBFT receipt-lifecycle slice; replacement/cancellation classification and
live runtime conformance remain held under tracked follow-up work. Do not use this package as
evidence of a public Torium network or hosted RPC.

## Localnet

```ts
import {
  toriumLocalnet,
  validateToriumEndpoint,
} from "@torium-network/sdk/chains";
import { createToriumPublicClient } from "@torium-network/sdk/clients";
import { http } from "viem";

const client = createToriumPublicClient({
  chain: toriumLocalnet,
  transport: http(),
});

const status = await client.getToriumNetworkStatus();
console.log(status.blockNumber, status.peerCount, status.finality.label);
```

Only localnet carries loopback defaults. Devnet, testnet, and mainnet have no
default RPC or explorer until canonical public services are approved. Use
`withToriumRpcUrls` for an immutable caller-owned override and ordinary viem
`fallback`, `http`, `webSocket`, or `custom` transports for transport policy.
The SDK never switches or adds a wallet network.

Endpoint validation reports compatibility as `not-requested` unless callers
provide explicit protocol, contract, or capability checks. Built-in contract
registry checks remain follow-up work; reconnect plus HTTP backfill likewise remains
follow-up work. A caller can also provide `minimumBlockNumber` to reject a stale
RPC response without the SDK inventing a global freshness threshold.

## Read compatibility

Standard reads such as `getBlock`, `getBalance`, `getTransaction`,
`getTransactionReceipt`, `getTransactionCount`, `getCode`,
`getStorageAt`, `getLogs`, fee/gas estimation, `readContract`, watch
actions, and raw `client.request` remain ordinary viem APIs with their native
bigint, hex, address, and ABI inference. The SDK does not create Torium-prefixed
copies of them.

`toriumReadCapabilities` records deviations proven by the pinned Cosmos EVM
v0.7.0 baseline and active local RPC profile. In particular:

- `safe` state queries are unsupported by stable helpers.
- `pending` is partial and does not promise a distinct pending-state view.
- `finalized` means the latest CometBFT-committed state, not Ethereum
  beacon-chain finality.
- the active local profile supports `newHeads` and `logs`, not pending
  transaction subscriptions or browser-origin WebSockets.
- disconnected subscriptions require client-owned reconnect and HTTP backfill;
  the node does not replay missed messages.
- log requests should be split into inclusive ranges of at most 10,000 blocks.
  If a response contains exactly 10,000 logs, narrow the range rather than
  assuming the response is complete.
- `eth_feeHistory` accepts from 1 through 100 blocks in the active profile.

The separately versioned Cosmos validator/staking/governance extension remains
an unusable `stub`: upstream REST/gRPC is not yet a stable Torium API, gRPC-Web
is disabled, and no frozen generated schema or capability handshake exists.
The standard EVM client remains fully usable without that extension.
Abort signals are forwarded to viem requests and surface as typed, redacted
errors. Torium-specific read helpers default to one attempt and accept an
explicit per-action timeout and a maximum of three attempts. Ordinary viem
actions retain viem's error and transport behavior.

## Amounts, addresses, and JSON

```ts
import {
  formatToriumAmount,
  parseToriumAmount,
  toriumBech32AddressToEvm,
  toriumEvmAddressToBech32,
} from "@torium-network/sdk/utils";

const baseUnits = parseToriumAmount("1.25");
const machineDisplay = formatToriumAmount(baseUnits);
const account = toriumEvmAddressToBech32(
  "0x00112233445566778899AABbCCdDeeFf00112233"
);
const evmAddress = toriumBech32AddressToEvm(account);
```

Amount helpers accept strings or bigint only, never JavaScript floating-point
numbers. They use a documented EVM-facing `uint256` range. Machine formatting
is locale-neutral; applications own user-locale presentation. Bech32 helpers
accept the `torium` account role only, not validator or consensus HRPs.

`stringifyToriumJson` and `parseToriumJson` use an explicit tagged envelope to
round-trip bigint fields inside otherwise JSON-compatible data. They do not
preserve non-JSON JavaScript types and are not an authenticity, schema-validation
or diagnostic-redaction layer. Untrusted input can imitate the tag. Never pass
secrets, credentials, provider objects, or signed payloads to generic
serialization.

## Wallet transaction foundation

`createToriumWalletClient` requires an explicit Torium chain and preserves
viem's local-account, JSON-RPC account and EIP-1193 transport behavior. The
stable Torium helper accepts standard EIP-1559 native transfers, contract calls
and deployments. It validates fields, checks the endpoint chain, simulates,
estimates gas and fees, compares the pending nonce and calculates maximum cost
before signing.

`sendToriumTransactionOnce` repeats that preflight immediately before invoking
the caller-owned wallet exactly once. Its required `authorize` callback exposes
the fresh resolved gas, fee, nonce and encoded-size values before signing; the
request sent to the wallet uses exactly those values. A returned hash means RPC
acknowledgement only; it does not guarantee mempool retention, inclusion or finality.
`waitForToriumTransaction` disables viem replacement detection and returns only
`committed`, `reverted` or `unknown` on an actual receipt timeout. Other RPC
failures propagate. `unknown` is never safe evidence for automatic resubmission.

The base wallet still exposes standard viem legacy and EIP-2930 actions. The
stable Torium helper does not accept EIP-4844, EIP-7702, chain overrides or
`assertChainId: false`, and exports no replacement or cancellation helper.

## Errors, retries, and diagnostics

Import `ToriumSdkError`, `isToriumSdkError`, and the stable category/code types
from `@torium-network/sdk/errors`. Torium endpoint checks, Torium-specific client
actions, and asynchronous Torium wallet actions normalize failures at their public boundary.
Direct viem actions deliberately keep viem's native errors.

Every Torium action defaults to one attempt. Only idempotent read helpers accept
an explicit `retry` option, capped at three total attempts. Broadcast helpers do
not accept retry configuration and invoke the caller-owned sender once, even
when the result is a timeout or transport failure. `safeToRetry` describes the
failed operation only; it never makes a transaction resubmission safe.

Torium action options also accept `signal`, a per-action `timeoutMs` capped at
five minutes, `requestId`, and an opt-in `diagnostics` hook. Diagnostic events
are non-blocking and contain an allowlisted code/category/method/status context
only. They never
contain URLs, headers, RPC parameters, calldata, addresses, provider objects, or
the upstream error cause. Applications still own their viem transport's global
timeout, batching, fallback, and retry policy.

## Runtime compatibility

The package declares Node `>=22.23.1 <23 || >=24 <25`. CI runs the complete SDK
verification once on Node 22.23.1 and a lightweight ESM/CommonJS import gate on
Node 24 without repeating the full suite.

The maintained Vite journey is built for ES2022, audited through emitted source
maps for Node polyfills and product-backend dependencies, and held below 115 KB
gzip including viem. Caller-owned EIP-1193 behavior is tested for canonical
chain verification, one standard transaction request, and no silent wallet
network mutation.

The React Native 0.81 fixture is compiled by Metro into Hermes bytecode. The
source graph rejects Node polyfills and product-backend dependencies, while
bytecode and module-count budgets detect accidental growth. Mobile hosts still
own protected account storage, unlock policy, provider sessions and lifecycle
cleanup. These gates do not claim a live device, specific wallet adapter or
public network; those integration journeys remain live-integration follow-up work.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @torium-network/sdk verify
```

The verification command formats and type-checks once, builds both module
formats and condition-specific declarations once, runs runtime tests, checks
the canonical read-capability inputs, publint and Are the Types Wrong, creates
a packed tarball, installs it into
clean ESM and CommonJS fixtures, checks public API/package manifest snapshots,
tests tree shaking, scans build output, and enforces bundle budgets.

`npm pack` requires an existing successful build and fails with a direct
instruction when `dist` is absent; it never emits a silently incomplete
tarball from a clean checkout.

## Integration boundary

The SDK will accept standard viem transports and EIP-1193 providers. It does
not authenticate with the Torium product backend, connect to its database, own
wallet secrets, implement a bridge, or invent public RPC endpoints.

The architecture contract is documented in
`docs/decisions/2026-07-15-torium-sdk-v0-architecture.md`.
