# Chain environment configuration

Environment names are `localnet`, `devnet`, `testnet` and `mainnet`. Canonical
chain IDs, EVM chain IDs, currency metadata and Bech32 prefixes come only from
`chain/config/identifiers.json`; overlays must reference rather than redefine
them.

## Safety rules

- Local development defaults only to loopback endpoints and valueless local
  keys. There is no fallback from a missing local endpoint to a public RPC.
- Commands that target `devnet`, `testnet` or `mainnet` require an explicit
  `TORIUM_CHAIN_ENV` and endpoint/config selection. Mutating public-network
  commands also require the confirmation mechanism owned by the future ops
  issue.
- Public endpoint arrays stay empty until an environment is approved and
  deployed. Placeholder domains are not runtime defaults.
- Private keys, validator keys, mnemonics, seed phrases, node homes, keyrings,
  peer identity keys and production credentials are never committed. Only
  clearly fake `*.example` templates may be tracked.
- `localnet` state can be deleted and recreated. No other environment assumes
  local state, product-backend access or a Torium user identity.

Configuration layering is: immutable identifier manifest, environment overlay,
then explicit process environment. There is no implicit cross-environment
fallback.
