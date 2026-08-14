#!/usr/bin/env node
/**
 * Scenario runner for issue #119. Executes canonical resilience scenarios
 * against the already-running four-validator localnet with real fault
 * injection (container stop/start, Docker network partitions, dependency
 * outage), records the full per-height/per-node commit audit, and emits
 * schema-valid results under chain/resilience/results/.
 *
 * Implemented scenarios:
 *   local-one-validator-offline    local-two-validators-offline
 *   local-three-one-partition      local-two-two-partition
 *   local-all-validator-restart    local-rpc-explorer-outage
 *   local-single-equivocation      local-unsafe-byzantine-threshold
 *   local-validator-set-change     local-clock-and-network-delay
 *   local-proposer-censorship
 *
 * Fault surfaces beyond container stop/start and Docker partitions:
 *   - duplicate consensus signer from a second data directory (equivocation)
 *   - protocol downtime jailing (validator-set change)
 *   - netem delay/loss from a privileged helper in the target netns
 *   - a build-tag-gated censoring PrepareProposal fixture on ONE validator
 *     (chain/app/censorfixture); three configuration-level censorship routes
 *     were tried first and each failed for a concrete reason recorded in
 *     chain/resilience/README.md
 *
 * Usage: node chain/resilience/run-scenario-v0.mjs --scenario <id|implemented>
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const RUNNER_RELATIVE_PATH = "chain/resilience/run-scenario-v0.mjs";
const RUNNER_IDENTITY = `${RUNNER_RELATIVE_PATH}@0.1.0`;
const COMPOSE_FILE = path.join(repositoryRoot, "chain/localnet/compose.yaml");
const CENSOR_COMPOSE_FILE = path.join(
  repositoryRoot,
  "chain/resilience/compose.censor-fixture.yaml"
);
const CENSOR_IMAGE = "toriumd:censor-fixture";
const RELEASE_IMAGE = "toriumd:local";
// The exact line chain/app/censorfixture/enabled.go writes when it drops
// transactions. The drill's proof of censorship is the censoring proposer's own
// audit record, not an inference from block contents.
const CENSOR_ACTIVE_LOG = "torium-censor-fixture build is ACTIVE";
const CENSOR_DROP_LOG =
  "torium-censor-fixture dropped transactions from its own proposal";
const CENSOR_MARKED_TRANSACTIONS = 14;
const NETWORK = "torium-localnet_consensus";
const NODES = [
  { nodeId: "validator-0", container: "torium-localnet-validator-0-1", rpcPort: 26657 },
  { nodeId: "validator-1", container: "torium-localnet-validator-1-1", rpcPort: 26757 },
  { nodeId: "validator-2", container: "torium-localnet-validator-2-1", rpcPort: 26857 },
  { nodeId: "validator-3", container: "torium-localnet-validator-3-1", rpcPort: 26957 },
];

const plan = JSON.parse(
  await readFile(path.join(here, "resilience-plan-v0.json"), "utf8")
);

function parseArguments(argv) {
  const result = { scenario: "", seed: 20260729 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--scenario") result.scenario = argv[index + 1];
    if (argv[index] === "--seed") result.seed = Number(argv[index + 1]);
  }
  if (!result.scenario) {
    console.error("--scenario <id|implemented> is required");
    process.exit(64);
  }
  return result;
}
const options = parseArguments(process.argv.slice(2));

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

async function commandOutput(command, args, options = {}) {
  const { stdout } = await execFile(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  return stdout.trim();
}

async function compose(...args) {
  return commandOutput("docker", ["compose", "--file", COMPOSE_FILE, ...args]);
}

async function cometRequest(node, endpoint) {
  const response = await fetch(`http://127.0.0.1:${node.rpcPort}${endpoint}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`comet ${endpoint} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`comet ${endpoint}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function latestHeight(node) {
  const status = await cometRequest(node, "/status");
  return Number(status.sync_info.latest_block_height);
}

async function commitAt(node, height) {
  const result = await cometRequest(node, `/commit?height=${height}`);
  const header = result.signed_header.header;
  // The commit carries one signature slot per validator in the set for that
  // height (absent ones included), so the set size — not the launch topology —
  // is the correct denominator once jailing or tombstoning shrinks the set.
  const slots = result.signed_header.commit.signatures;
  const signatures = slots.filter(
    (signature) =>
      signature.block_id_flag === 2 || signature.block_id_flag === "BLOCK_ID_FLAG_COMMIT"
  );
  return {
    committedState: {
      nodeId: node.nodeId,
      height,
      blockHash: result.signed_header.commit.block_id.hash,
      appHash: header.app_hash,
      commitVotingPower: Math.round(
        (signatures.length / Math.max(1, slots.length)) * 100
      ),
    },
    validatorsHash: header.validators_hash,
  };
}

function sleep(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// --- shared fault-injection helpers ---------------------------------------

const REST_URL = "http://127.0.0.1:1317";
const EVM_RPC_URL = "http://127.0.0.1:8545";
const DEV_FAUCET_URL = "http://127.0.0.1:8080";
const EVM_CHAIN_ID = 1414484556;
const NETEM_IMAGE = "torium-netem-helper:local";
const STATE_ROOT = path.join(repositoryRoot, "chain/localnet/.state/container");

const sdkRequire = createRequire(
  pathToFileURL(path.join(repositoryRoot, "packages/torium-sdk/package.json"))
);

async function restJson(endpoint) {
  const response = await fetch(`${REST_URL}${endpoint}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`REST ${endpoint} HTTP ${response.status}`);
  return response.json();
}

async function evmRpc(method, params) {
  const response = await fetch(EVM_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function fundAddress(address, amountBaseUnits) {
  const response = await fetch(`${DEV_FAUCET_URL}/v1/fund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, amountBaseUnits }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (response.status !== 201) {
    throw new Error(`dev faucet funding failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

// Steady valueless EVM traffic, so proposal contents differ between nodes and
// transaction inclusion is observable. Returns a stop handle.
async function startTransactionTraffic() {
  const { privateKeyToAccount } = await import(
    pathToFileURL(sdkRequire.resolve("viem/accounts"))
  );
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  await fundAddress(account.address, "20000000000000000000");
  let nonce = Number(
    await evmRpc("eth_getTransactionCount", [account.address, "pending"])
  );
  let running = true;
  const submitted = [];
  const loop = (async () => {
    while (running) {
      try {
        const baseFee = BigInt(
          (await evmRpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas
        );
        const signed = await account.signTransaction({
          chainId: EVM_CHAIN_ID,
          to: `0x${createHash("sha256").update(`torium-resilience/${nonce}`).digest("hex").slice(0, 40)}`,
          value: 1n,
          gas: 21_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
          maxFeePerGas: baseFee * 4n + 1_000_000_000n,
          nonce,
          type: "eip1559",
        });
        const hash = await evmRpc("eth_sendRawTransaction", [signed]);
        submitted.push({ hash, submittedAt: nowIso() });
        nonce += 1;
      } catch {
        // Transient rejection during a fault window is expected; keep going.
      }
      await sleep(700);
    }
  })();
  return {
    submitted,
    async stop() {
      running = false;
      await loop;
    },
  };
}


// --- proposer censorship (#119) -------------------------------------------

async function composeCensor(args, environment) {
  return commandOutput(
    "docker",
    ["compose", "--file", COMPOSE_FILE, "--file", CENSOR_COMPOSE_FILE, ...args],
    { env: environment }
  );
}

// Building the fixture image is a heavy Docker build; it must not run
// concurrently with another one.
async function ensureCensorFixtureImage() {
  await commandOutput("make", [
    "--no-print-directory",
    "-C",
    path.join(repositoryRoot, "chain/app"),
    "container-censor-fixture",
  ]);
  const image = await commandOutput("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    CENSOR_IMAGE,
  ]);
  if (!image.startsWith("sha256:")) {
    throw new Error(`fixture image ${CENSOR_IMAGE} was not built`);
  }
  return image;
}

// The compiled-artifact proof: the release image must not contain the fixture's
// log string, and the fixture image must. This is stronger than reading a flag,
// because it inspects the binaries that actually run.
async function censorFixtureBinaryBoundary() {
  const probe = async (image) =>
    commandOutput("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      image,
      "-c",
      `if grep -qa ${JSON.stringify(CENSOR_DROP_LOG)} /usr/local/bin/toriumd; then echo present; else echo absent; fi`,
    ]);
  const release = await probe(RELEASE_IMAGE);
  const fixture = await probe(CENSOR_IMAGE);
  if (release !== "absent") {
    throw new Error(
      `the release image ${RELEASE_IMAGE} contains the censoring fixture; the build tag is not gating it`
    );
  }
  if (fixture !== "present") {
    throw new Error(
      `the fixture image ${CENSOR_IMAGE} does not contain the censoring fixture; it was built without the tag`
    );
  }
  return { releaseImageContainsFixture: false, fixtureImageContainsFixture: true };
}

// A recreated container answers its CometBFT RPC only once the node has
// started; calling latestHeight() straight after `compose up` races the
// listener and fails with a socket close.
async function waitNodeReachable(node, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      return await latestHeight(node);
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${node.nodeId} never answered CometBFT RPC after recreation`);
      }
      await sleep(2_000);
    }
  }
}

async function containerImage(container) {
  return commandOutput("docker", [
    "inspect",
    "--format",
    "{{.Config.Image}}",
    container,
  ]);
}

// Read the fixture's drop records out of the censoring validator's own log.
async function censorDropRecords(container, sinceIso) {
  const logs = await commandOutput("docker", [
    "logs",
    "--since",
    sinceIso,
    container,
  ]).catch(() => "");
  const records = [];
  for (const line of logs.split("\n")) {
    if (!line.includes(CENSOR_DROP_LOG)) continue;
    // The node logs JSON; fall back to the raw line if a frame is truncated.
    try {
      const frame = JSON.parse(line.slice(line.indexOf("{")));
      records.push({
        height: Number(frame.height),
        dropped: Number(frame.dropped),
        kept: Number(frame.kept),
        policy: String(frame.policy ?? ""),
      });
    } catch {
      records.push({ height: null, dropped: null, kept: null, policy: line.trim() });
    }
  }
  return records;
}

// A batch of transactions that all carry the same 32-byte marker in their call
// data. The marker is what the fixture matches: `data` is a protobuf `bytes`
// field, so the marker appears as contiguous raw bytes in the Cosmos
// transaction the proposal handler sees. Matching on the recipient would not
// work — cosmos-evm encodes `to` as an ASCII hex string.
async function submitMarkedTransactions(marker, count) {
  const { privateKeyToAccount } = await import(
    pathToFileURL(sdkRequire.resolve("viem/accounts"))
  );
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  await fundAddress(account.address, "20000000000000000000");
  let nonce = Number(
    await evmRpc("eth_getTransactionCount", [account.address, "pending"])
  );
  const recipient = `0x${createHash("sha256")
    .update("torium-censorship-recipient")
    .digest("hex")
    .slice(0, 40)}`;
  const submitted = [];
  for (let index = 0; index < count; index += 1) {
    const baseFee = BigInt(
      (await evmRpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas
    );
    const signed = await account.signTransaction({
      chainId: EVM_CHAIN_ID,
      to: recipient,
      value: 1n,
      data: `0x${marker}`,
      gas: 120_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: baseFee * 4n + 1_000_000_000n,
      nonce,
      type: "eip1559",
    });
    submitted.push({
      hash: await evmRpc("eth_sendRawTransaction", [signed]),
      submittedAt: nowIso(),
    });
    nonce += 1;
    await sleep(900);
  }
  return { account: account.address, recipient, submitted };
}

async function waitForReceipts(hashes, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  const receipts = new Map();
  for (;;) {
    for (const hash of hashes) {
      if (receipts.has(hash)) continue;
      const receipt = await evmRpc("eth_getTransactionReceipt", [hash]).catch(
        () => null
      );
      if (receipt?.blockNumber) {
        receipts.set(hash, Number(BigInt(receipt.blockNumber)));
      }
    }
    if (receipts.size === hashes.length) return receipts;
    if (Date.now() > deadline) return receipts;
    await sleep(1_500);
  }
}

async function blockSummary(node, height) {
  const result = await cometRequest(node, `/block?height=${height}`);
  return {
    height,
    proposerAddress: result.block.header.proposer_address,
    transactionCount: (result.block.data.txs ?? []).length,
    evidenceCount: (result.block.evidence?.evidence ?? []).length,
  };
}

async function ensureNetemImage() {
  const dockerfile = [
    "FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40",
    // apk records a wall-clock install time in /var/log/apk.log; drop it in
    // the same layer so the helper image stays byte-reproducible.
    "RUN apk add --no-cache iproute2 && rm -f /var/log/apk.log",
    "",
  ].join("\n");
  const contextDir = path.join(
    repositoryRoot,
    "chain/resilience/.artifacts/netem-helper"
  );
  await mkdir(contextDir, { recursive: true });
  await writeFile(path.join(contextDir, "Dockerfile"), dockerfile);
  await commandOutput("docker", [
    "build",
    "--tag",
    NETEM_IMAGE,
    "--file",
    path.join(contextDir, "Dockerfile"),
    contextDir,
  ]);
}

// netem is applied from a privileged helper joined to the target container's
// network namespace, so the validator containers keep cap_drop: ALL.
async function netem(container, ...arguments_) {
  await commandOutput("docker", [
    "run",
    "--rm",
    "--network",
    `container:${container}`,
    "--cap-add",
    "NET_ADMIN",
    NETEM_IMAGE,
    "tc",
    ...arguments_,
  ]);
}

// --- validator clone (equivocation) helpers -------------------------------

// A clone reuses one validator's consensus key from a second data directory.
// It is exactly the accidental-duplicate-signer failure the key-compromise
// runbook forbids, and the only way to produce real duplicate-vote evidence
// without patching consensus code.
async function startValidatorClone(node) {
  const cloneId = `${node.nodeId}-clone`;
  const cloneHome = path.join(STATE_ROOT, cloneId);
  await rm(cloneHome, { recursive: true, force: true });
  // Copy a quiesced data directory: copying a live embedded database yields a
  // torn snapshot the clone cannot open. Stopping one validator is safe here
  // because the remaining 75% keeps the quorum.
  await compose("stop", node.nodeId);
  try {
    await cp(path.join(STATE_ROOT, node.nodeId), cloneHome, { recursive: true });
  } finally {
    await compose("start", node.nodeId);
  }
  // A distinct p2p identity, so both instances can be connected at once.
  // CometBFT stores an Ed25519 private key as seed||public (64 bytes); random
  // bytes fail the p2p secret-connection challenge instead of being rejected
  // outright, so the key has to be a real generated pair.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  await writeFile(
    path.join(cloneHome, "config/node_key.json"),
    `${JSON.stringify({
      priv_key: {
        type: "tendermint/PrivKeyEd25519",
        value: Buffer.concat([seed, publicRaw]).toString("base64"),
      },
    })}\n`
  );
  const container = `torium-localnet-${cloneId}`;
  await commandOutput("docker", ["rm", "--force", container]).catch(() => "");
  await commandOutput("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--hostname",
    cloneId,
    "--network",
    NETWORK,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--volume",
    `${cloneHome}:/var/lib/torium`,
    "toriumd:local",
    "start",
    "--home",
    "/var/lib/torium",
    "--log_format",
    "json",
    "--log_no_color",
  ]);
  return { cloneId, container, cloneHome };
}

async function stopValidatorClone(clone) {
  await commandOutput("docker", ["rm", "--force", clone.container]).catch(() => "");
  await rm(clone.cloneHome, { recursive: true, force: true });
}

// Duplicate-vote evidence lands in a committed block; the slashing module then
// jails and tombstones the signer.
async function waitForEquivocationEvidence(node, fromHeight, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let scanned = fromHeight;
  const evidenceHeights = [];
  for (;;) {
    const head = await latestHeight(node).catch(() => scanned);
    while (scanned <= head) {
      const summary = await blockSummary(node, scanned).catch(() => null);
      if (summary && summary.evidenceCount > 0) evidenceHeights.push(scanned);
      scanned += 1;
    }
    if (evidenceHeights.length > 0) return { evidenceHeights, head };
    if (Date.now() > deadline) return { evidenceHeights, head };
    await sleep(2_000);
  }
}

async function tombstonedSigners() {
  const infos = await restJson(
    "/cosmos/slashing/v1beta1/signing_infos?pagination.limit=100"
  );
  return infos.info
    .filter(({ tombstoned }) => tombstoned)
    .map(({ address }) => address);
}

async function waitHeightAdvance(node, fromHeight, byAtLeast, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      const height = await latestHeight(node);
      if (height >= fromHeight + byAtLeast) return height;
    } catch {
      // Node may be mid-restart; keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`${node.nodeId} did not advance ${byAtLeast} heights in time`);
    }
    await sleep(400);
  }
}

// observeHalt proves NO commit progress: samples the reachable node's height
// over the window and requires at most one in-flight commit to land.
async function observeHalt(node, windowMilliseconds) {
  const first = await latestHeight(node).catch(() => null);
  await sleep(windowMilliseconds);
  const last = await latestHeight(node).catch(() => first);
  if (first === null) return { halted: true, first: null, last: null };
  return { halted: last - first <= 1, first, last };
}

// --- scenario fault modules ----------------------------------------------

const faults = {
  "local-one-validator-offline": {
    nodesDown: ["validator-1"],
    async inject(context) {
      await compose("stop", "validator-1");
      context.decide("stopped validator-1 (25% power offline; quorum retained)");
    },
    async observe(context) {
      const height = await waitHeightAdvance(NODES[0], context.faultHeight, 5, 60_000);
      context.observed.liveness =
        "commits continued on the 75% quorum after at most a proposer-round delay";
      context.observed.finality = "committed heights kept one canonical history";
      return height;
    },
    async recover(context) {
      await compose("start", "validator-1");
      context.decide("restarted validator-1; no state was edited");
      context.observed.recovery =
        "restarted validator caught up from canonical peers without state edits";
    },
  },
  "local-two-validators-offline": {
    nodesDown: ["validator-1", "validator-2"],
    async inject(context) {
      await compose("stop", "validator-1", "validator-2");
      context.decide("stopped validator-1 and validator-2 (50% power; quorum lost)");
    },
    async observe(context) {
      const halt = await observeHalt(NODES[0], 15_000);
      if (!halt.halted) throw new Error("chain kept committing without strict quorum");
      context.observed.liveness = `commits halted without quorum (height held at ${halt.last})`;
      context.observed.finality =
        "no new committed height was produced without strict quorum";
      return halt.last ?? context.faultHeight;
    },
    async recover(context) {
      await compose("start", "validator-1", "validator-2");
      context.decide("restarted both validators; commits may resume only with quorum");
      context.observed.recovery = "commits resumed only after strict quorum returned";
    },
  },
  "local-three-one-partition": {
    nodesDown: [],
    async inject(context) {
      await commandOutput("docker", ["network", "disconnect", NETWORK, NODES[3].container]);
      context.decide("partitioned validator-3 from the consensus network (75/25 split)");
    },
    async observe(context) {
      const majorityHeight = await waitHeightAdvance(NODES[0], context.faultHeight, 5, 60_000);
      const isolated = await observeHalt(NODES[3], 6_000);
      if (!isolated.halted) throw new Error("isolated 25% side committed new heights");
      context.observed.liveness =
        "the 75% side kept committing while the isolated 25% side could not commit";
      context.observed.finality = "only the 75% side produced committed heights";
      context.observed.safety =
        "the isolated validator held its last committed state without edits";
      return majorityHeight;
    },
    async recover(context) {
      await commandOutput("docker", ["network", "connect", NETWORK, NODES[3].container]);
      context.decide("healed the partition; validator-3 must catch up from peers");
      context.observed.recovery =
        "after healing, the lagging validator caught up without state edits";
    },
  },
  "local-two-two-partition": {
    nodesDown: [],
    async inject(context) {
      await commandOutput("docker", ["network", "disconnect", NETWORK, NODES[2].container]);
      await commandOutput("docker", ["network", "disconnect", NETWORK, NODES[3].container]);
      context.decide("partitioned validators 2+3 from validators 0+1 (50/50 split)");
    },
    async observe(context) {
      const sideA = await observeHalt(NODES[0], 15_000);
      const sideB = await observeHalt(NODES[2], 1_000);
      if (!sideA.halted || !sideB.halted) {
        throw new Error("a 50% side committed new heights during the partition");
      }
      context.observed.liveness = "both 50% sides halted";
      context.observed.safety = "neither side committed a conflicting block";
      context.observed.finality = "neither 50% side produced a committed height";
      return sideA.last ?? context.faultHeight;
    },
    async recover(context) {
      await commandOutput("docker", ["network", "connect", NETWORK, NODES[2].container]);
      await commandOutput("docker", ["network", "connect", NETWORK, NODES[3].container]);
      context.decide("healed the partition; commits require strict quorum again");
      context.observed.recovery = "commits resumed only after the partition healed";
    },
  },
  "local-all-validator-restart": {
    nodesDown: ["validator-0", "validator-1", "validator-2", "validator-3"],
    async inject(context) {
      await compose("stop", "validator-0", "validator-1", "validator-2", "validator-3");
      context.decide("stopped the whole validator set (coordinated full restart)");
    },
    async observe(context) {
      // With every node stopped the halt is definitional; verify none of the
      // RPC endpoints answer.
      let reachable = 0;
      for (const node of NODES) {
        try {
          await latestHeight(node);
          reachable += 1;
        } catch {
          // expected: node is stopped
        }
      }
      if (reachable > 0) throw new Error("a validator kept serving during the full stop");
      context.observed.liveness = "the chain halted while every validator was stopped";
      return context.faultHeight;
    },
    async recover(context) {
      await compose("start", "validator-0", "validator-1", "validator-2", "validator-3");
      context.decide("restarted the full validator set from persisted state; no edits");
      context.observed.safety =
        "the restarted set resumed from the same genesis and application hash without edits";
      context.observed.finality = "post-restart commits extended the same canonical history";
      context.observed.recovery =
        "restart used persisted state with the same genesis and application hash";
    },
  },
  "local-single-equivocation": {
    nodesDown: [],
    async inject(context) {
      context.scratch.traffic = await startTransactionTraffic();
      context.scratch.tombstonedBefore = await tombstonedSigners();
      context.scratch.clones = [await startValidatorClone(NODES[1])];
      context.decide(
        "started a duplicate signer for validator-1 (25% power) from a second " +
          "data directory reusing its consensus key, with steady transaction " +
          "traffic so the two instances propose different block contents"
      );
    },
    async observe(context) {
      const { evidenceHeights, head } = await waitForEquivocationEvidence(
        NODES[0],
        context.faultHeight,
        300_000
      );
      const tombstonedAfter = await tombstonedSigners();
      const newlyTombstoned = tombstonedAfter.filter(
        (address) => !context.scratch.tombstonedBefore.includes(address)
      );
      const jailed = (await restJson("/cosmos/staking/v1beta1/validators")).validators
        .filter(({ jailed: isJailed }) => isJailed)
        .map(({ operator_address: operator }) => operator);
      context.scratch.equivocationEvidence = {
        evidenceHeights,
        newlyTombstonedSigners: newlyTombstoned.length,
        jailedOperators: jailed.length,
      };
      if (evidenceHeights.length === 0) {
        throw new Error(
          "no duplicate-vote evidence was committed within the drill window"
        );
      }
      context.observed.liveness =
        "the honest 75% power kept committing while the duplicate signer ran";
      context.observed.safety =
        `duplicate-vote evidence was committed at height(s) ` +
        `${evidenceHeights.join(",")} and the signer was ` +
        `${newlyTombstoned.length > 0 ? "tombstoned" : "jailed"} without any ` +
        "conflicting commit";
      context.observed.finality =
        "committed heights remained a single canonical history throughout";
      return head;
    },
    async recover(context) {
      await context.scratch.traffic.stop();
      for (const clone of context.scratch.clones) {
        await stopValidatorClone(clone);
      }
      context.decide(
        "removed the duplicate signer; the compromised identity stays " +
          "quarantined (jailed/tombstoned) and evidence is preserved on chain"
      );
      context.observed.recovery =
        "the duplicate signer was quarantined, its slashing evidence stayed " +
        "committed, and the honest set continued without state edits";
    },
  },
  "local-unsafe-byzantine-threshold": {
    nodesDown: [],
    assumptionViolation: true,
    async inject(context) {
      context.scratch.traffic = await startTransactionTraffic();
      context.scratch.tombstonedBefore = await tombstonedSigners();
      context.scratch.clones = [
        await startValidatorClone(NODES[2]),
        await startValidatorClone(NODES[3]),
      ];
      context.decide(
        "started duplicate signers for validator-2 and validator-3 (50% of " +
          "voting power), deliberately violating the documented <1/3 " +
          "byzantine trust assumption"
      );
    },
    async observe(context) {
      const { evidenceHeights, head } = await waitForEquivocationEvidence(
        NODES[0],
        context.faultHeight,
        300_000
      );
      const tombstonedAfter = await tombstonedSigners();
      const newlyTombstoned = tombstonedAfter.filter(
        (address) => !context.scratch.tombstonedBefore.includes(address)
      );
      context.scratch.assumptionViolationEvidence = {
        evidenceHeights,
        newlyTombstonedSigners: newlyTombstoned.length,
        byzantinePowerPercent: 50,
      };
      context.observed.liveness =
        "no liveness guarantee applies outside the trust envelope; the " +
        `observed head advanced to ${head} during the experiment`;
      context.observed.finality =
        "no finality guarantee applies at 50% byzantine power; the audit " +
        "below records what was actually committed";
      // Safety is deliberately NOT asserted here: whatever the audit finds is
      // the honest outcome of an out-of-envelope experiment.
      return head;
    },
    async recover(context) {
      await context.scratch.traffic.stop();
      for (const clone of context.scratch.clones) {
        await stopValidatorClone(clone);
      }
      context.decide(
        "stopped the experiment, removed both duplicate signers, and preserved " +
          "all committed evidence; this outcome blocks release readiness by design"
      );
      context.observed.recovery =
        "the experiment was stopped, evidence preserved, and release readiness " +
        "stays blocked for the out-of-envelope condition";
    },
  },
  "local-validator-set-change": {
    nodesDown: ["validator-3"],
    async inject(context) {
      const before = await restJson(
        "/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED"
      );
      context.scratch.bondedBefore = before.validators.length;
      context.scratch.validatorsHashBefore = (
        await commitAt(NODES[0], context.faultHeight)
      ).validatorsHash;
      await compose("stop", "validator-3");
      context.decide(
        "stopped validator-3 so the protocol itself jails it for downtime " +
          "(signed_blocks_window 100, minimum_signed_per_window 0.5)"
      );
    },
    async observe(context) {
      // The set transition is driven by the slashing module, not by an
      // operator edit: wait for the bonded set to shrink while the remaining
      // 75% power keeps committing.
      const deadline = Date.now() + 600_000;
      let bondedAfter = context.scratch.bondedBefore;
      let jailed = [];
      for (;;) {
        const all = await restJson("/cosmos/staking/v1beta1/validators");
        jailed = all.validators.filter(({ jailed: isJailed }) => isJailed);
        const bonded = await restJson(
          "/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED"
        );
        bondedAfter = bonded.validators.length;
        if (bondedAfter < context.scratch.bondedBefore && jailed.length >= 1) break;
        if (Date.now() > deadline) {
          throw new Error("validator-3 was never jailed within the drill window");
        }
        await sleep(3_000);
      }
      // A validator update committed at height H only appears in the header's
      // validators_hash from H+2 onwards, so advance past the transition
      // before comparing the committed set.
      const height = await waitHeightAdvance(
        NODES[0],
        await latestHeight(NODES[0]),
        5,
        120_000
      );
      const validatorsHashAfter = (await commitAt(NODES[0], height)).validatorsHash;
      if (validatorsHashAfter === context.scratch.validatorsHashBefore) {
        throw new Error("the committed validator set hash never changed");
      }
      context.scratch.bondedAfter = bondedAfter;
      context.scratch.jailedOperators = jailed.map(
        ({ operator_address: operator }) => operator
      );
      context.observed.liveness =
        `commits continued on the reduced ${bondedAfter}-validator set after the ` +
        "downtime jailing removed one member";
      context.observed.safety =
        "the validator update was applied through committed slashing state, " +
        "and each commit used the effective historical validator set";
      context.observed.finality =
        `committed heights stayed one canonical history across the set change ` +
        `(validators_hash ${context.scratch.validatorsHashBefore.slice(0, 12)}… → ` +
        `${validatorsHashAfter.slice(0, 12)}…)`;
      return await waitHeightAdvance(NODES[0], height, 3, 120_000);
    },
    async recover(context) {
      await compose("start", "validator-3");
      context.decide(
        "restarted validator-3; it stays jailed until an explicit unjail " +
          "transaction, and no state was edited"
      );
      context.observed.recovery =
        "the restarted member caught up from committed validator updates " +
        "without any state edit; unjailing remains an explicit operator action";
    },
  },
  "local-clock-and-network-delay": {
    nodesDown: [],
    async inject(context) {
      await ensureNetemImage();
      context.scratch.netemNodes = [NODES[2], NODES[3]];
      for (const node of context.scratch.netemNodes) {
        await netem(
          node.container,
          "qdisc",
          "add",
          "dev",
          "eth0",
          "root",
          "netem",
          "delay",
          "900ms",
          "300ms",
          "distribution",
          "normal",
          "loss",
          "12%"
        );
      }
      context.decide(
        "applied netem delay 900ms±300ms with 12% packet loss to validator-2 " +
          "and validator-3 from a privileged helper sharing their network " +
          "namespace (the validators keep cap_drop: ALL)"
      );
    },
    async observe(context) {
      // Delay far above the propose/prevote timeouts must not fork the chain;
      // the round machinery may slow down or stall while the network is
      // untimely.
      const start = await latestHeight(NODES[0]);
      await sleep(45_000);
      const during = await latestHeight(NODES[0]).catch(() => start);
      context.scratch.heightsDuringFault = during - start;
      context.observed.liveness =
        during > start
          ? `commits continued at a reduced rate under an untimely network ` +
            `(${during - start} heights in 45s)`
          : "commits stalled while the network was untimely, as the round " +
            "timeouts require timely proposals";
      context.observed.finality =
        "no validator committed a conflicting block while the network was untimely";
      return during;
    },
    async recover(context) {
      for (const node of context.scratch.netemNodes) {
        await netem(node.container, "qdisc", "del", "dev", "eth0", "root");
      }
      context.decide("removed the netem qdisc; the network is timely again");
      context.observed.recovery =
        "after the fault was removed the chain recovered through increasing " +
        "round timeouts, with no state edit";
    },
  },
  "local-rpc-explorer-outage": {
    nodesDown: [],
    async inject(context) {
      await compose("stop", "faucet");
      context.decide("stopped the faucet query dependency (consensus untouched)");
    },
    async observe(context) {
      const height = await waitHeightAdvance(NODES[0], context.faultHeight, 5, 60_000);
      context.observed.liveness = "consensus continued while the query dependency was down";
      context.observed.finality =
        "consensus finality stayed independent of the query dependency";
      return height;
    },
    async recover(context) {
      await compose("start", "faucet");
      // Prove the dependency backfills from the canonical chain: its health
      // endpoint reports current chain state again.
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const response = await fetch("http://127.0.0.1:8080/healthz", {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) break;
        } catch {
          // dependency still starting
        }
        if (Date.now() > deadline) throw new Error("dependency never became healthy again");
        await sleep(500);
      }
      context.decide("restarted the dependency; it re-read canonical chain state");
      context.observed.safety = "the dependency backfilled from the canonical chain";
      context.observed.recovery =
        "dependencies restarted and backfilled from the canonical chain";
    },
  },
  "local-proposer-censorship": {
    nodesDown: [],
    async inject(context) {
      // Prove the boundary BEFORE using the fixture: the release image must not
      // contain the censoring code at all. A drill that cannot demonstrate that
      // would be evidence that release binaries can censor.
      context.scratch.censorImageId = await ensureCensorFixtureImage();
      context.scratch.censorBinaryBoundary = await censorFixtureBinaryBoundary();

      const marker = randomBytes(32).toString("hex");
      context.scratch.censorMarker = marker;
      const target = NODES[1];
      context.scratch.censorNode = target;
      const topology = JSON.parse(
        await readFile(
          path.join(
            repositoryRoot,
            "chain/localnet/.state/container/topology.json"
          ),
          "utf8"
        )
      );
      const censorTopology = topology.nodes.find(
        ({ name }) => name === target.nodeId
      );
      if (!censorTopology) throw new Error(`${target.nodeId} is not in the topology`);
      context.scratch.censorProposerAddress = censorTopology.consensus_address_hex;

      context.scratch.censorStartedAt = nowIso();
      await composeCensor(
        ["up", "--detach", "--no-deps", "--force-recreate", target.nodeId],
        {
          TORIUM_CENSOR_NEEDLE: marker,
          TORIUM_UID: String(process.getuid?.() ?? 10001),
          TORIUM_GID: String(process.getgid?.() ?? 10001),
        }
      );
      // The recreated container must actually be the fixture image running the
      // fixture, or every later observation is a false negative.
      const image = await containerImage(target.container);
      if (image !== CENSOR_IMAGE) {
        throw new Error(`${target.nodeId} runs ${image}, expected ${CENSOR_IMAGE}`);
      }
      const activationDeadline = Date.now() + 120_000;
      for (;;) {
        const logs = await commandOutput("docker", ["logs", target.container]).catch(() => "");
        if (logs.includes(CENSOR_ACTIVE_LOG)) break;
        if (Date.now() > activationDeadline) {
          throw new Error(
            `${target.nodeId} never reported the censoring fixture as active; the drill would be a false negative`
          );
        }
        await sleep(2_000);
      }
      // Wait for it to rejoin and catch up, so it takes proposer turns.
      await waitHeightAdvance(target, await waitNodeReachable(target, 180_000), 2, 180_000);
      context.decide(
        `replaced ${target.nodeId} with the build-tag-gated censoring fixture ` +
          `image (25% of voting power) configured to drop transactions carrying ` +
          `a 32-byte marker; every other validator keeps ${RELEASE_IMAGE}`
      );
    },
    async observe(context) {
      const target = context.scratch.censorNode;
      const windowStart = await latestHeight(NODES[0]);
      const batch = await submitMarkedTransactions(
        context.scratch.censorMarker,
        CENSOR_MARKED_TRANSACTIONS
      );
      context.scratch.censorBatch = batch;
      const hashes = batch.submitted.map(({ hash }) => hash);
      const receipts = await waitForReceipts(hashes, 300_000);
      const windowEnd = await waitHeightAdvance(
        NODES[0],
        await latestHeight(NODES[0]),
        2,
        120_000
      );

      // Which heights in the window did the censoring validator propose?
      const proposals = [];
      for (let height = windowStart; height <= windowEnd; height += 1) {
        const summary = await blockSummary(NODES[0], height);
        proposals.push(summary);
      }
      const censorProposedHeights = proposals
        .filter(
          ({ proposerAddress }) =>
            proposerAddress === context.scratch.censorProposerAddress
        )
        .map(({ height }) => height);
      if (censorProposedHeights.length === 0) {
        throw new Error(
          "the censoring validator never proposed a block during the window; the observation would be inconclusive"
        );
      }

      const drops = await censorDropRecords(
        target.container,
        context.scratch.censorStartedAt
      );
      if (drops.length === 0) {
        throw new Error(
          "the censoring validator recorded no dropped transactions, so no censorship was actually injected"
        );
      }

      // The decisive invariant: a marked transaction must never appear in a
      // block the censoring validator proposed. If one did, the fixture did not
      // censor and the whole observation is void.
      const includedAtCensorHeight = [...receipts.entries()].filter(([, height]) =>
        censorProposedHeights.includes(height)
      );
      if (includedAtCensorHeight.length > 0) {
        throw new Error(
          `marked transactions were included in blocks proposed by the censoring validator at heights ${includedAtCensorHeight
            .map(([, height]) => height)
            .join(",")}`
        );
      }
      if (receipts.size !== hashes.length) {
        throw new Error(
          `only ${receipts.size} of ${hashes.length} marked transactions were ever included; a 25% censoring proposer must not deny inclusion outright`
        );
      }

      const inclusionHeights = [...receipts.values()].sort((left, right) => left - right);
      context.scratch.censorshipEvidence = {
        marker: context.scratch.censorMarker,
        censoringNode: target.nodeId,
        censoringProposerAddress: context.scratch.censorProposerAddress,
        censoringImage: CENSOR_IMAGE,
        censoringImageId: context.scratch.censorImageId,
        binaryBoundary: context.scratch.censorBinaryBoundary,
        windowStartHeight: windowStart,
        windowEndHeight: windowEnd,
        heightsProposedByCensoringValidator: censorProposedHeights,
        dropRecords: drops,
        markedTransactions: batch.submitted.map(({ hash, submittedAt }) => ({
          hash,
          submittedAt,
          includedAtHeight: receipts.get(hash) ?? null,
        })),
        markedTransactionsIncluded: receipts.size,
        markedTransactionsIncludedByCensoringValidator: 0,
        inclusionHeightRange: [inclusionHeights[0], inclusionHeights.at(-1)],
      };

      const totalDropped = drops.reduce(
        (sum, record) => sum + (record.dropped ?? 0),
        0
      );
      context.observed.liveness =
        `blocks kept committing while a 25%-power proposer censored: it dropped ` +
        `${totalDropped} marked transaction(s) across ${drops.length} of its own ` +
        `${censorProposedHeights.length} proposal(s), and no marked transaction ` +
        `appeared in any block it proposed; inclusion was delayed, not bounded`;
      context.observed.safety =
        "the censoring proposer produced valid blocks that honest validators " +
        "accepted — it omitted transactions rather than committing anything " +
        "invalid — and the transaction lifecycle stayed observable over RPC";
      context.observed.finality =
        `block finality continued across heights ${windowStart}–${windowEnd}; ` +
        `every marked transaction was eventually included by an honest proposer ` +
        `(heights ${inclusionHeights[0]}–${inclusionHeights.at(-1)}), which is a ` +
        `delay and not a bounded inclusion guarantee`;
      return windowEnd;
    },
    async recover(context) {
      const target = context.scratch.censorNode;
      // Restore the release image. The recovery proof is that the same node,
      // running a binary that cannot censor, now includes a marked transaction.
      await compose("up", "--detach", "--no-deps", "--force-recreate", target.nodeId);
      const image = await containerImage(target.container);
      if (image !== RELEASE_IMAGE) {
        throw new Error(`${target.nodeId} runs ${image} after recovery, expected ${RELEASE_IMAGE}`);
      }
      await waitHeightAdvance(target, await waitNodeReachable(target, 180_000), 2, 180_000);
      const followUp = await submitMarkedTransactions(context.scratch.censorMarker, 1);
      const receipts = await waitForReceipts(
        followUp.submitted.map(({ hash }) => hash),
        180_000
      );
      if (receipts.size !== 1) {
        throw new Error("a marked transaction was still not included after recovery");
      }
      const restoredLogs = await commandOutput("docker", [
        "logs",
        target.container,
      ]).catch(() => "");
      if (restoredLogs.includes(CENSOR_ACTIVE_LOG)) {
        throw new Error("the restored node still reports the censoring fixture as active");
      }
      context.scratch.censorshipEvidence.recovery = {
        restoredImage: image,
        fixtureActiveAfterRecovery: false,
        followUpTransaction: followUp.submitted[0].hash,
        followUpIncludedAtHeight: [...receipts.values()][0],
      };
      context.decide(
        `restored ${target.nodeId} to ${RELEASE_IMAGE}; no state was edited and ` +
          "the censoring code is absent from the restored binary"
      );
      context.observed.recovery =
        "the transaction lifecycle stayed observable throughout, and once the " +
        "censoring proposer was replaced by a release binary a marked " +
        "transaction was included again; no inclusion promise is claimed";
    },
  },
};

// --- provenance -----------------------------------------------------------

async function collectProvenance() {
  const gitCommit = await commandOutput("git", ["-C", repositoryRoot, "rev-parse", "HEAD"]);
  const trackedDirty =
    (await commandOutput("git", [
      "-C",
      repositoryRoot,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])) !== "";
  let patchSha256 = null;
  let patchContent = null;
  if (trackedDirty) {
    patchContent = await commandOutput("git", ["-C", repositoryRoot, "diff", "HEAD"]);
    patchSha256 = sha256(Buffer.from(`${patchContent}\n`));
  }
  const binaryHash = (
    await commandOutput("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "toriumd:local",
      "-c",
      "sha256sum /usr/local/bin/toriumd",
    ])
  ).split(/\s+/u)[0];
  const stateGenesis = await readFile(
    path.join(repositoryRoot, "chain/localnet/.state/container/validator-0/config/genesis.json")
  );
  const configDir = path.join(
    repositoryRoot,
    "chain/localnet/.state/container/validator-0/config"
  );
  const effectiveConfig = [
    await readFile(path.join(configDir, "app.toml"), "utf8"),
    await readFile(path.join(configDir, "config.toml"), "utf8"),
  ].join("\n");
  return {
    provenance: {
      gitCommit,
      dirtyWorktree: trackedDirty,
      patchSha256,
      toolchainSha256: sha256(await readFile(path.join(repositoryRoot, "chain/toolchain.json"))),
      binaryIdentity: "toriumd (toriumd:local)",
      binarySha256: binaryHash,
      genesisSha256: sha256(stateGenesis),
      effectiveConfigSha256: sha256(Buffer.from(effectiveConfig)),
      hostIdentity: `${os.type()} ${os.release()} ${os.arch()} (${os.cpus().length} cores)`,
      runnerIdentity: RUNNER_IDENTITY,
      seed: options.seed,
    },
    patchContent,
  };
}

// --- scenario execution ---------------------------------------------------

// A failed injection or observation must not leave duplicate signers, netem
// qdiscs, censoring configuration, or traffic generators behind.
async function bestEffortCleanup(context, fault) {
  for (const nodeId of fault?.nodesDown ?? []) {
    await compose("start", nodeId).catch(() => {});
  }
  if (context.scratch.traffic) {
    await context.scratch.traffic.stop().catch(() => {});
  }
  for (const clone of context.scratch.clones ?? []) {
    await stopValidatorClone(clone).catch(() => {});
  }
  for (const node of context.scratch.netemNodes ?? []) {
    await netem(node.container, "qdisc", "del", "dev", "eth0", "root").catch(
      () => {}
    );
  }
  // A failed censorship drill must never leave a censoring binary running.
  if (context.scratch.censorNode) {
    await compose(
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      context.scratch.censorNode.nodeId
    ).catch(() => {});
  }
}

const SCENARIO_LIMITATIONS = {
  "local-validator-set-change": [
    "the validator-set transition is produced by protocol downtime jailing rather than an operator-signed staking transaction, so create-validator and unjail transaction paths stay covered only by chain/app/localnet/validator_lifecycle_test.go",
  ],
  "local-clock-and-network-delay": [
    "latency and packet loss are injected with netem from a privileged helper joined to the target container network namespace; host clock skew is NOT injected because container clocks come from the shared host kernel",
  ],
  "local-proposer-censorship": [
    "censorship is injected by replacing ONE validator (25% power) with a build-tag-gated PrepareProposal fixture image; the tag is never passed by any release or container build, and the drill first proves the release binary does not contain the fixture at all",
    "the fixture drops transactions carrying a 32-byte marker in their call data rather than all traffic, so the drill measures inclusion delay for identified transactions instead of halting the chain",
    "a censoring proposer that also produced invalid blocks is NOT covered: this fixture only omits transactions from its own proposals",
  ],
  "local-single-equivocation": [
    "equivocation is produced by running a second instance with the same consensus key (the accidental duplicate-signer failure mode), not by patching consensus code",
  ],
  "local-unsafe-byzantine-threshold": [
    "equivocation is produced by running duplicate signers for two validators (50% power), deliberately outside the documented <1/3 byzantine trust envelope",
    "this experiment blocks release readiness by design; its outcome is a boundary demonstration, not a defect report",
  ],
};

async function runScenario(scenario) {
  const fault = faults[scenario.id];
  if (!fault) throw new Error(`scenario ${scenario.id} has no implemented fault module`);
  console.log(`running scenario ${scenario.id}`);

  for (const node of NODES) {
    await latestHeight(node);
  }
  const startedAt = nowIso();
  const timeline = [];
  const operatorDecisions = [];
  const context = {
    faultHeight: 0,
    scratch: {},
    observed: { liveness: null, safety: null, finality: null, recovery: null },
    decide(decision, reason) {
      operatorDecisions.push({
        at: nowIso(),
        decision,
        reason: reason ?? "scenario plan step for this canonical fault drill",
      });
    },
  };

  const startHeight = await latestHeight(NODES[0]);
  const baseline = (await commitAt(NODES[0], startHeight)).committedState;
  timeline.push({
    at: nowIso(),
    kind: "baseline",
    height: startHeight,
    note: "all four validators reachable at the baseline committed height",
  });

  context.faultHeight = startHeight;
  try {
    await fault.inject(context);
  } catch (error) {
    await bestEffortCleanup(context, fault);
    throw error;
  }
  timeline.push({
    at: nowIso(),
    kind: "change-applied",
    height: startHeight,
    note: "fault injected per the scenario module",
  });

  let observedHeight;
  try {
    observedHeight = await fault.observe(context);
  } catch (error) {
    await bestEffortCleanup(context, fault);
    throw error;
  }
  timeline.push({
    at: nowIso(),
    kind: "expected-behavior-observed",
    height: Math.max(startHeight, observedHeight),
    note: "expected liveness/finality behavior observed under the fault",
  });

  const recoveryStartedAt = nowIso();
  timeline.push({
    at: recoveryStartedAt,
    kind: "recovery-started",
    height: Math.max(startHeight, observedHeight),
    note: "operator recovery action started",
  });
  await fault.recover(context);

  // Recovery completes when every node reaches one canonical height.
  const liveHeights = await Promise.all(
    NODES.map((node) => latestHeight(node).catch(() => 0))
  );
  const targetHeight = Math.max(...liveHeights, observedHeight) + 3;
  for (const node of NODES) {
    await waitHeightAdvance(node, targetHeight, 0, 120_000);
  }
  const canonicalHeight = targetHeight;
  const recoveryCompletedAt = nowIso();
  timeline.push({
    at: recoveryCompletedAt,
    kind: "recovery-complete",
    height: canonicalHeight,
    note: "every validator reached the canonical recovery height",
  });

  const nodeObservations = [];
  for (const node of NODES) {
    const commit = await commitAt(node, canonicalHeight);
    nodeObservations.push({
      nodeId: node.nodeId,
      reachable: true,
      height: canonicalHeight,
      blockHash: commit.committedState.blockHash,
      appHash: commit.committedState.appHash,
      validatorsHash: commit.validatorsHash,
    });
  }

  const endHeight = canonicalHeight;
  const committedStates = [];
  for (let height = startHeight; height <= endHeight; height += 1) {
    for (const node of NODES) {
      committedStates.push((await commitAt(node, height)).committedState);
    }
  }
  const commitsByHeight = new Map();
  for (const committed of committedStates) {
    const commits = commitsByHeight.get(committed.height) ?? [];
    commits.push(committed);
    commitsByHeight.set(committed.height, commits);
  }
  const contradictoryHeights = [...commitsByHeight.entries()]
    .filter(
      ([, commits]) =>
        new Set(commits.map(({ blockHash, appHash }) => `${blockHash}:${appHash}`)).size > 1
    )
    .map(([height]) => height)
    .sort((left, right) => left - right);

  context.observed.safety =
    context.observed.safety ??
    (contradictoryHeights.length === 0
      ? "no conflicting committed block was observed at any audited height"
      : `conflicting commits observed at heights ${contradictoryHeights.join(",")}`);
  const endedAt = nowIso();

  const assertions = {
    liveness: {
      expected: scenario.expectedLiveness,
      observed: context.observed.liveness,
      passed: context.observed.liveness !== null,
    },
    safety: {
      expected: scenario.expectedSafety,
      observed: context.observed.safety,
      // An assumption-violation experiment makes no safety promise, so the
      // audit records what happened instead of grading it.
      passed: fault.assumptionViolation ? true : contradictoryHeights.length === 0,
    },
    finality: {
      expected: scenario.expectedFinality,
      observed:
        context.observed.finality ??
        "committed heights formed one contiguous canonical history across all validators",
      passed: fault.assumptionViolation ? true : contradictoryHeights.length === 0,
    },
    recovery: {
      expected: scenario.expectedRecovery,
      observed: context.observed.recovery,
      passed:
        context.observed.recovery !== null &&
        nodeObservations.every(
          (observation) =>
            observation.appHash === nodeObservations[0].appHash &&
            observation.blockHash === nodeObservations[0].blockHash
        ),
    },
  };
  const allPassed = Object.values(assertions).every(({ passed }) => passed === true);
  // An assumption-violation experiment is "unsafe" by construction: it runs
  // outside the documented trust envelope, so it can never report "pass" even
  // when the audit finds no conflicting commit.
  const status = fault.assumptionViolation
    ? "unsafe"
    : contradictoryHeights.length > 0
      ? "unsafe"
      : allPassed
        ? "pass"
        : "fail";

  const artifactsDirRelative = path.posix.join(
    "chain/resilience/results/artifacts",
    scenario.id
  );
  await mkdir(path.join(repositoryRoot, artifactsDirRelative), { recursive: true });
  const artifacts = [];
  const writeArtifact = async (kind, name, body) => {
    const relativePath = path.posix.join(artifactsDirRelative, name);
    const content = `${JSON.stringify(body, null, 2)}\n`;
    await writeFile(path.join(repositoryRoot, relativePath), content);
    artifacts.push({
      kind,
      relativePath,
      sha256: sha256(Buffer.from(content)),
      containsSecrets: false,
    });
  };
  await writeArtifact("timeline", "timeline.json", timeline);
  await writeArtifact("node-observations", "node-observations.json", nodeObservations);
  await writeArtifact("commit-audit", "commit-audit.json", committedStates);
  await writeArtifact("operator-decisions", "operator-decisions.json", operatorDecisions);
  for (const [key, kind] of [
    ["equivocationEvidence", "equivocation-evidence"],
    ["assumptionViolationEvidence", "assumption-violation-evidence"],
  ]) {
    if (context.scratch[key]) {
      await writeArtifact(kind, `${kind}.json`, context.scratch[key]);
    }
  }
  if (context.scratch.censorshipEvidence) {
    await writeArtifact(
      "proposer-censorship-evidence",
      "proposer-censorship-evidence.json",
      context.scratch.censorshipEvidence
    );
  }
  if (context.scratch.bondedAfter !== undefined) {
    await writeArtifact("validator-set-change", "validator-set-change.json", {
      bondedBefore: context.scratch.bondedBefore,
      bondedAfter: context.scratch.bondedAfter,
      jailedOperators: context.scratch.jailedOperators,
      validatorsHashBefore: context.scratch.validatorsHashBefore,
    });
  }

  const { provenance, patchContent } = await collectProvenance();
  if (patchContent !== null) {
    const relativePath = path.posix.join(artifactsDirRelative, "worktree.patch");
    await writeFile(path.join(repositoryRoot, relativePath), `${patchContent}\n`);
    artifacts.push({
      kind: "worktree-patch",
      relativePath,
      sha256: provenance.patchSha256,
      containsSecrets: false,
    });
  }

  const result = {
    schemaVersion: 1,
    resultVersion: "0.1.0",
    status,
    ownerIssue: 119,
    planVersion: plan.planVersion,
    scenarioId: scenario.id,
    testId: scenario.testId,
    executed: true,
    provenance,
    run: {
      startedAt,
      endedAt,
      cosmosChainId: "torium-localnet-1",
      evmChainId: 1414484556,
      startHeight,
      endHeight,
      baselineBlockHash: baseline.blockHash,
      baselineAppHash: baseline.appHash,
    },
    timeline,
    observations: { nodes: nodeObservations, committedStates },
    assertions,
    recovery: {
      manualStateEdits: false,
      startedAt: recoveryStartedAt,
      completedAt: recoveryCompletedAt,
      durationMilliseconds:
        new Date(recoveryCompletedAt).getTime() - new Date(recoveryStartedAt).getTime(),
      canonicalHeight,
      canonicalAppHash: nodeObservations[0].appHash,
    },
    contradictoryCommitAudit: {
      overlappingHeightsChecked: commitsByHeight.size,
      contradictionObserved: contradictoryHeights.length > 0,
      contradictoryHeights,
      evidenceComplete: true,
    },
    operatorDecisions,
    artifacts,
    // An assumption-violation experiment always blocks release readiness,
    // whatever it observes: it demonstrates the boundary of the trust model.
    releaseBlocked: fault.assumptionViolation ? true : status !== "pass",
    limitations: [
      "local four-validator Compose topology; container stop/start and Docker network partitions are the fault surface",
      "commit audit reads each validator's post-recovery view of every audited height over CometBFT RPC",
      ...(SCENARIO_LIMITATIONS[scenario.id] ?? []),
    ],
  };

  const resultPath = path.join(
    repositoryRoot,
    "chain/resilience/results",
    `${scenario.id}.result.json`
  );
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`  ${status.toUpperCase()} — wrote ${path.relative(repositoryRoot, resultPath)}`);
  return { scenarioId: scenario.id, status };
}

const implemented = Object.keys(faults);
const targets =
  options.scenario === "implemented"
    ? plan.canonicalScenarios.filter(({ id }) => implemented.includes(id))
    : plan.canonicalScenarios.filter(({ id }) => id === options.scenario);
if (targets.length === 0) {
  console.error(`unknown or unimplemented scenario ${options.scenario}`);
  process.exit(64);
}
const outcomes = [];
for (const scenario of targets) {
  outcomes.push(await runScenario(scenario));
}
console.log(JSON.stringify(outcomes));
