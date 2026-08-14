# Generated documentation inputs

Generated ABI, RPC and SDK references are written below this directory by their owner issues. Do not
hand-edit them.

`sdk-<version>.api.md` mirrors the SDK's byte-checked declaration report and is owned by a follow-up workstream.
The adjacent manifest records every public code subpath, runtime export and declaration hash.
Run `pnpm --filter developer-docs generate:sdk-reference` after an approved SDK API change. Docs
validation uses `--check` and fails if either the mirror or the routed API page is stale. A follow-up workstream
owns the later release-wide drift and executable-snippet gates; the docs shell work only established this
ownership boundary.
