#!/usr/bin/env node

const warning =
  "VALUELESS LOCAL DEVELOPMENT ONLY — tTOR dispensed by this faucet has no monetary value.";

const args = parseArgs(process.argv.slice(2));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), args.timeoutSeconds * 1000);
try {
  const response = await fetch(
    args.health ? `${args.url}/healthz` : `${args.url}/v1/fund`,
    {
      method: args.health ? "GET" : "POST",
      headers: args.health ? {} : { "content-type": "application/json" },
      body: args.health
        ? undefined
        : JSON.stringify({
            address: args.address,
            ...(args.amountBaseUnits
              ? { amountBaseUnits: args.amountBaseUnits }
              : {}),
          }),
      signal: controller.signal,
    }
  );
  const payload = await response.json();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (response.ok && args.health) {
    process.stdout.write(
      `${payload.warning ?? warning}\nLocal faucet: ${payload.status}; block=${payload.blockNumber}; signer=${payload.signerAddress}; balance=${payload.signerBalanceBaseUnits} atorium\n`
    );
  } else if (response.ok) {
    process.stdout.write(
      `${payload.warning ?? warning}\nFunded ${payload.recipient} with ${payload.amountBaseUnits} atorium (${payload.displayDenom}).\nTransaction: ${payload.transactionHash}\nBlock: ${payload.blockNumber} (${payload.blockHash})\n`
    );
  } else {
    process.stderr.write(
      `${payload.warning ?? warning}\nLocal faucet request failed (${response.status}): ${payload.error ?? "unknown error"}\n`
    );
  }
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${warning}\nLocal faucet is unavailable at ${args.url}: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

function parseArgs(argv) {
  const parsed = {
    address: null,
    amountBaseUnits: null,
    url: "http://127.0.0.1:8080",
    health: false,
    json: false,
    timeoutSeconds: 50,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--address":
        parsed.address = argv[++index];
        break;
      case "--amount-base-units":
        parsed.amountBaseUnits = argv[++index];
        break;
      case "--url":
        parsed.url = argv[++index];
        break;
      case "--health":
        parsed.health = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--timeout":
        parsed.timeoutSeconds = Number(argv[++index]);
        break;
      default:
        throw new Error(`unknown faucet request option ${value}`);
    }
  }
  if (!parsed.health && !/^0x[0-9a-fA-F]{40}$/u.test(parsed.address ?? "")) {
    throw new Error("--address must be an exact 20-byte 0x-prefixed EVM address");
  }
  if (
    parsed.amountBaseUnits !== null &&
    !/^[0-9]+$/u.test(parsed.amountBaseUnits)
  ) {
    throw new Error("--amount-base-units must be an unsigned base-10 integer");
  }
  if (!Number.isInteger(parsed.timeoutSeconds) || parsed.timeoutSeconds < 1) {
    throw new Error("--timeout must be a positive integer");
  }
  if (parsed.url !== "http://127.0.0.1:8080") {
    throw new Error("the local faucet helper only permits http://127.0.0.1:8080");
  }
  return parsed;
}
