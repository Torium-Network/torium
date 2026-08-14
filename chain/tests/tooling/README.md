# Torium EVM tooling conformance

This suite runs common Ethereum developer clients directly against the
canonical, valueless four-validator Torium localnet. It proves that viem,
ethers, Hardhat, Foundry, Solidity 0.8.30, and unmodified OpenZeppelin ERC-20
and ERC-721 implementations work without Torium-specific contract patches.

Run the automated suite from the repository root:

```bash
make -C chain/tests/tooling test
```

The suite resets and starts the existing canonical localnet, derives only the
public disposable deployer fixture in memory, deploys the OpenZeppelin probes,
checks calls/logs/reverts, records `.artifacts/latest-report.json`, verifies
Hardhat's L1 provider, and checks the digest-pinned Foundry client. It does not
start a second chain implementation or contact a hosted endpoint.

The canonical proof currently records a partial gas-estimation capability:
`eth_estimateGas` returned `22,430` for the OpenZeppelin ERC-20 transfer, the
transaction reverted at that exact limit, and a `250,000` explicit limit
succeeded while consuming `125,000`. The runner retains both attempts so this
difference cannot be hidden by client defaults. Gas above actual usage is a
limit, not an amount automatically charged.

MetaMask requires a visible Chromium session and therefore remains a separate
operator-triggered proof. Supply a newly generated disposable local mnemonic
through the process environment; it is never committed or written to the
report. The probe imports that wallet, adds the canonical custom network,
funds the selected account through the loopback faucet, sends one valueless
transaction, and captures machine-readable evidence plus a screenshot:

```bash
TORIUM_DEV_MNEMONIC='<fresh local-only words>' \
  make -C chain/tests/tooling metamask
```

The pinned historical upstream PoC MetaMask proof remains the reproducible upstream
baseline. This canonical runner must be repeated when the extension version,
chain metadata, RPC policy, or wallet onboarding flow changes.

State as of 2026-07-29 (second pass; the live-wallet verification follow-up still open):

- Two more code-level blockers were cleared and one honest fallback added:
  the probe no longer mistakes MetaMask's own "sending" state for a failure to
  confirm (acknowledging the localized fee alert can itself submit the
  transaction), it requests explicit EIP-1559 fees above the local 1 gwei
  base-fee floor instead of relying on wallet-side estimation on an idle
  chain, and if the dapp promise never settles it recovers the confirmed
  transfer's hash from the canonical chain (only the imported key can produce
  that transaction, so the evidence is equivalent).
- Four full runs later the lane still fails: MetaMask reaches its sending
  state, the provider promise never resolves, and the chain scan finds no
  matching transaction — i.e. the extension never broadcasts. That is the same
  renderer-instability signature as before, now with the wallet-side reasons
  ruled out.
- Recording the canonical screenshot still needs an operator-driven headed
  session on a host with a stable extension renderer.

Earlier state (first pass):

- The fee-warning blocker is resolved in code. `metamask-probe.mjs` now walks
  MetaMask 13.39.2's localized review modal (open alert → acknowledge →
  dismiss) and clicks the footer confirm button only once Playwright
  considers it enabled. Force-clicking it while disabled was silently a
  no-op, which is why earlier runs exhausted their approval steps.
- The remaining blocker is environmental, not a selector problem: on this
  host the dapp page's renderer dies mid-request with
  `page.evaluate: Target crashed` at `eth_sendTransaction` approval step 2.
  Three headed runs reproduced it after successful onboarding, custom-network
  import, account connection, and loopback faucet funding.
- Recording the canonical signed-transfer screenshot therefore still needs an
  operator-driven headed session (or a host where the extension renderer is
  stable). It is not a default CI requirement.
