# Reviewed post-genesis deployment automation

`deploy-testnet.mjs` deploys the pinned generated artifacts to an explicitly
configured public environment. It is fail-closed:

- The environment, chain identity and deployment plan come from a reviewed,
  committed configuration file (`contracts/config/testnet-deployment-v1.json`).
- RPC and signing material are caller-provided (`TORIUM_DEPLOY_RPC_URL`,
  `TORIUM_DEPLOY_KEY_FILE`) and never live in the repository. The key file must
  control the configured deployer authority or the run aborts.
- The script refuses to run against a chain whose `eth_chainId` differs from
  the configured environment.
- Generated artifacts are verified against the pinned registry checksums and
  creation-code hashes before anything is sent.
- The factory deploy requires the exact nonce-zero prediction; CREATE2 deploys
  go through `ToriumCreate2Factory.deploy`, which additionally enforces the
  expected runtime code hash on chain.
- Every deployed or reused address is re-verified against the pinned runtime
  code hash, and the emitted record contains no secret.

Dry run (predicts addresses, checks existing code, sends nothing):

```bash
cd contracts
TORIUM_DEPLOY_RPC_URL=https://rpc.testnet.torium.network \
  node script/deploy-testnet.mjs --config config/testnet-deployment-v1.json
```

Broadcast (requires the operations key file):

```bash
cd contracts
TORIUM_DEPLOY_RPC_URL=https://rpc.testnet.torium.network \
TORIUM_DEPLOY_KEY_FILE=/path/outside/the/repository \
  node script/deploy-testnet.mjs \
  --config config/testnet-deployment-v1.json \
  --output /tmp/torium-testnet-deployment.json \
  --broadcast
```

Reruns are idempotent: matching runtime code at a predicted address is reused
and re-verified; mismatching code aborts the run. The emitted record is the
input for the committed deployment registry
(`contracts/deployments/testnet.json`); promotion into the registry is a
separate reviewed step, never automatic.
