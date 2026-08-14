# Torium public faucet acceptance suite

Executes the held public-faucet test plan
against a real localnet:

1. **Contract validation** — the service contract
   (`chain/config/public-faucet-service-v0.json`) stays
   fail-closed (`publicDeploymentAllowed: false`).
2. **Localnet boot** — canonical four-validator chain plus the loopback dev
   faucet (used here only as the offline-reserve stand-in for refills).
3. **Signer provisioning** — a fresh, dedicated signer key is generated per
   run (never a fixture or validator key), funded from the reserve stand-in,
   and mounted read-only into the service container.
4. **Finalized funding** — one real `POST /v1/fund` request is driven to
   `confirmed` and cross-checked against the chain: EIP-1559 type, replay
   domain `0x544f524c`, sender, recipient, value, and recipient balance.
5. **Concurrency and replay** — parallel same-idempotency-key requests
   collapse to one request; parallel distinct-address requests admit exactly
   the remaining daily budget; replays never create new transactions; the
   cooldown and the budget breaker engage.
6. **RPC outage + hard restart** — validator-0 is killed, a request wedges,
   the RPC breaker opens, the service is SIGKILLed and restarted, and the
   journal-recovered request confirms exactly once after the chain returns.
7. **Nonce contention** — an external transaction from the same signer races
   a funding request; the request still confirms exactly once.
8. **Pause / drain / refill / rotation** — the emergency procedures from the
   design contract, including hash-chained journal verification and startup
   fencing of rotated-out keys.

Run locally (never in hosted CI — see the chain E2E policy):

```sh
make -C chain/tests/public-faucet test
```

Requires Docker, `curl`, `jq`, `node`, and the localnet image (built
automatically by `torium-localnet start`). Budget/limit parameters come from
the `local-rehearsal` profile of the service contract; pure-logic controls
(token buckets, denylists, breaker windows) are covered by the Go unit tests
in `chain/app/publicfaucet`.
