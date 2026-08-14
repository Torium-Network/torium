# Torium EVM ownership and review policy

GitHub path ownership is declared in `.github/CODEOWNERS`. The current fallback
owner is `@ToriumNetwork` because no separate chain team is configured yet.

## Review requirements

- Chain consensus, genesis, staking economics, identifiers, cryptography,
  system contracts and deployment configuration require an approving review
  from the chain owner.
- Generated artifacts must be reviewed through their source change and a clean
  reproducibility check, not by manually editing generated output.
- Public endpoint, testnet/mainnet, validator key handling and release changes
  require a second named security/release reviewer before public testnet. That
  reviewer is not assigned yet, so those changes are blocked from public
  release even if GitHub technically permits merging.

Branch protection is an external repository setting and must eventually enforce
CODEOWNERS approval, required checks and no direct pushes for release branches.
Until it is configured, these requirements remain process gates documented in
issues and pull requests.
