# Public API reports

The API Markdown and package-content JSON files in this directory are generated
from built declarations, runtime exports, and packed tarball contents.
Regenerate them with:

```bash
pnpm --filter @torium-network/sdk build
node packages/torium-sdk/scripts/validate-package.mjs --write
```

Review every diff. Normal validation fails when generated reports drift.
