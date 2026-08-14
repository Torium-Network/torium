# Torium native Solidity interface

[`../src/interfaces/IToriumNative.sol`](../src/interfaces/IToriumNative.sol) is
the canonical contract-facing interface for native TOR. This directory remains
as a stable documentation link after the source moved into the Foundry layout.
It is available at the fixed precompile address
`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` on every Torium environment.

The address is a Cosmos EVM WERC20 precompile backed directly by the
`atorium` balance in `x/bank`. It is not a deployed ERC-20, bridge token, or
separate wrapped asset. Therefore:

- `address(account).balance` and `balanceOf(account)` read the same amount;
- `totalSupply()` reads `x/bank` total supply;
- `transfer` and `transferFrom` move native `atorium` balances;
- `deposit` and `withdraw` exist for WETH compatibility but do not create or
  destroy a wrapped representation;
- there is no native coin conversion route and no second supply to reconcile.

The valueless localnet metadata is `Torium Local Token` / `tTOR` / 18 decimals.
Future public metadata uses the `TOR` display symbol, but no public genesis
amount, live token, or deployment is authorized by this interface.

A follow-up workstream owns the production contracts workspace, compiler pipeline, and
generated ABI artifacts. This issue-independent interface is already stable
enough for direct Solidity integrations and native-asset conformance tests.
