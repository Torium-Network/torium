# Torium Developer Docs

Local, versioned documentation for the Torium sovereign EVM L1 and TypeScript SDK.

## Local development

From the repository root:

```bash
pnpm install
pnpm dev:developer-docs
```

Open `http://localhost:3000/docs/v0`. The app has no required environment variables and does not
connect to the product backend. `pnpm --filter developer-docs verify` validates content ownership,
version compatibility, types and the production build.

To preview the production build locally:

```bash
pnpm --filter developer-docs build
pnpm --filter developer-docs start
```

## Version policy

- Every public page is rooted below `/docs/<version>` and declares the same version in frontmatter.
- Authored internal links are app-relative (`/v0/...`); Next adds the public `/docs` base path.
- `/docs/latest` is a temporary convenience redirect. Internal links and canonical URLs never use it.
- `content/versions.json` pins the compatible SDK and chain manifest tuple.
- Only `v0` exists today, so there is no active version switcher.
- Search requests carry an explicit version and results outside that route root are discarded.
- The local preview is deliberately `noindex`; follow-up workstreams own SEO/QA and approved publication.
- English is the only authored v0 locale. The route layout leaves room for a future locale segment
  without creating empty translations.

## Content ownership

A follow-up workstream owns the application shell, information architecture and guards. The content areas are:

- chain concepts, networks, localnet and local troubleshooting
- SDK guides and SDK API documentation
- Solidity tooling, contracts, deployments, rewards and attestations
- executable Node, browser, React Native and Solidity examples
- validator, node, observability, recovery, upgrade, security and incident runbooks
- non-SDK generated references, executable checks, search, accessibility, SEO and docs QA
- explicitly approved public publication and hosting

Every page declares `sourceStatus`. `existing` sources must resolve in the repository, `generated`
sources must remain below `content/generated/`, and `planned` sources are permitted only on planned
pages. The review transition is `planned` → `foundation` or `stable` after the owner issue verifies
claims and commands; retired content becomes `deprecated` inside its immutable version instead of
being silently rewritten.

One workstream owns the generated SDK API page and its source snapshot; another owns the later
cross-reference, link, snippet-execution and release-wide drift gates; this split prevents the SDK
guide from claiming that live localnet examples already run in docs CI.
