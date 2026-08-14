#!/usr/bin/env node
/**
 * Controlled local baseline runner for issue #118. Executes the three active
 * workloads from performance-v0.json against the already-running canonical
 * four-validator localnet and emits schema-valid capacity results with full
 * provenance, raw sample artifacts, and resource samples.
 *
 * Usage (localnet must already be running):
 *   node chain/performance/run-local-baselines.mjs --workload <id|all>
 *     [--results-dir chain/performance/results] [--seed 20260729]
 *
 * The runner never touches public endpoints and never claims safe TPS/QPS —
 * capacity claims stay null/false per the measurement contract.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { summarizeCaseSamples } from "./summarize-samples.mjs";

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const RUNNER_RELATIVE_PATH = "chain/performance/run-local-baselines.mjs";
const RUNNER_VERSION = "0.1.0";
const RPC_URL = "http://127.0.0.1:8545";
// The archive workload reads through the #114 gateway's loopback publication.
// The raw archive RPC is published nowhere, which is the point: a workload that
// could reach it would be measuring something the contract forbids.
const ARCHIVE_GATEWAY_RPC_URL = "http://127.0.0.1:38545";
const WORKLOAD_ENDPOINTS = {
  "validator-0-public-rpc": RPC_URL,
  "archive-rpc-gateway": ARCHIVE_GATEWAY_RPC_URL,
};
const DEV_FAUCET_URL = "http://127.0.0.1:8080";
const EVM_CHAIN_ID = 1414484556;
const ALPINE_IMAGE =
  "alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40";

const sdkRequire = createRequire(
  pathToFileURL(path.join(repositoryRoot, "packages/torium-sdk/package.json"))
);
const { privateKeyToAccount } = await import(
  pathToFileURL(sdkRequire.resolve("viem/accounts"))
);

function parseArguments(argv) {
  const result = {
    workload: "all",
    resultsDir: "chain/performance/results",
    seed: 20260729,
    label: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--workload") result.workload = argv[index + 1];
    if (argv[index] === "--results-dir") result.resultsDir = argv[index + 1];
    if (argv[index] === "--seed") result.seed = Number(argv[index + 1]);
    if (argv[index] === "--label") result.label = argv[index + 1];
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));
const plan = JSON.parse(
  await readFile(path.join(here, "performance-v0.json"), "utf8")
);
const protocol = JSON.parse(
  await readFile(path.join(repositoryRoot, "chain/config/protocol-v1.json"), "utf8")
);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

let jsonRpcIdentifier = 0;
async function rpcRequest(payload, endpointUrl = RPC_URL) {
  const body = JSON.stringify(payload);
  const startedAt = performance.now();
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  const elapsed = performance.now() - startedAt;
  if (!response.ok) {
    const error = new Error(`RPC HTTP ${response.status}`);
    error.elapsed = elapsed;
    error.bytes = Buffer.byteLength(text);
    throw error;
  }
  return { parsed: JSON.parse(text), elapsed, bytes: Buffer.byteLength(text) };
}

async function rpc(method, params = [], endpointUrl = RPC_URL) {
  jsonRpcIdentifier += 1;
  const { parsed } = await rpcRequest(
    {
      jsonrpc: "2.0",
      id: jsonRpcIdentifier,
      method,
      params,
    },
    endpointUrl
  );
  if (parsed.error) {
    throw new Error(`${method}: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

function hexToNumber(value) {
  return Number(BigInt(value));
}

function nowIso() {
  return new Date().toISOString();
}

async function commandOutput(command, args) {
  const { stdout } = await execFile(command, args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

// --- provenance -----------------------------------------------------------

async function collectProvenance(workload, datasetSha256, effectiveConfigSha256) {
  const gitCommit = await commandOutput("git", ["-C", repositoryRoot, "rev-parse", "HEAD"]);
  // dirtyWorktree describes the SOURCE that produced this measurement. This
  // runner's own committed results are its output, not an input: a batch run
  // writes result one before starting workload two, so counting them would mark
  // every workload after the first as patched even from a pristine checkout.
  // Everything outside the results directory still counts, so a real source edit
  // is still reported and still attaches a patch.
  const RESULTS_PREFIX = "chain/performance/results/";
  const dirtyEntries = (
    await commandOutput("git", [
      "-C",
      repositoryRoot,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !line.slice(2).trim().startsWith(RESULTS_PREFIX));
  const trackedDirty = dirtyEntries.length > 0;
  let patchSha256 = null;
  let patchContent = null;
  if (trackedDirty) {
    patchContent = await commandOutput("git", [
      "-C",
      repositoryRoot,
      "diff",
      "HEAD",
      "--",
      ".",
      `:(exclude)${RESULTS_PREFIX}`,
    ]);
    patchSha256 = sha256(Buffer.from(`${patchContent}\n`));
  }
  const dockerInfo = JSON.parse(
    await commandOutput("docker", ["system", "info", "--format", "json"])
  );
  const diskKilobytes = await commandOutput("docker", [
    "run",
    "--rm",
    ALPINE_IMAGE,
    "sh",
    "-c",
    "df -kP / | awk 'NR==2 {print $2}'",
  ]);
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
  const imageIdentifier = await commandOutput("docker", [
    "images",
    "--no-trunc",
    "--format",
    "{{.ID}}",
    "toriumd:local",
  ]);
  const stateGenesis = await readFile(
    path.join(
      repositoryRoot,
      "chain/localnet/.state/container/validator-0/config/genesis.json"
    )
  );
  const toolchainBytes = await readFile(path.join(repositoryRoot, "chain/toolchain.json"));
  const runnerBytes = await readFile(path.join(repositoryRoot, RUNNER_RELATIVE_PATH));
  return {
    provenance: {
      gitCommit,
      dirtyWorktree: trackedDirty,
      patchSha256,
      os: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      cpuModel: os.cpus()[0].model,
      logicalCores: os.cpus().length,
      memoryBytes: os.totalmem(),
      containerRuntime: await commandOutput("docker", ["--version"]),
      composeVersion: await commandOutput("docker", ["compose", "version", "--short"]),
      executionBackend: "container",
      virtualization: "docker-desktop-linux-vm",
      vmAllocation: {
        cpuCores: dockerInfo.NCPU,
        memoryBytes: dockerInfo.MemTotal,
        diskBytes: Number(diskKilobytes) * 1024,
      },
      filesystem: "host-apfs/vm-overlay2",
      statePath: "chain/localnet/.state/container",
      toolchainSha256: sha256(toolchainBytes),
      runnerVersion: RUNNER_VERSION,
      runnerSha256: sha256(runnerBytes),
      binaryIdentity: `toriumd (toriumd:local ${imageIdentifier.split("\n")[0]})`,
      binarySha256: binaryHash,
      genesisSha256: sha256(stateGenesis),
      effectiveConfigSha256,
      datasetSha256,
      workload: {
        id: workload.id,
        version: workload.version,
        definitionSha256: hashJson(workload),
        seed: options.seed,
        operationCount: workload.operationCount ?? workload.jsonRpcCallCount,
        concurrency: workload.concurrency,
        warmupCount: 0,
        repetition: 1,
      },
    },
    patchContent,
  };
}

// --- resource sampling ----------------------------------------------------

const VALIDATORS = ["validator-0", "validator-1", "validator-2", "validator-3"];

function parseDockerSize(value) {
  const match = value.trim().match(/^([0-9.]+)\s*([A-Za-z]+)$/u);
  if (!match) return null;
  const multipliers = {
    B: 1,
    kB: 1e3,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  const multiplier = multipliers[match[2]];
  if (multiplier === undefined) return null;
  return Math.round(Number(match[1]) * multiplier);
}

async function sampleResourcesOnce() {
  const stdout = await commandOutput("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
    ...VALIDATORS.map((validator) => `torium-localnet-${validator}-1`),
  ]);
  const at = nowIso();
  const containers = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry) => {
      const [rss] = entry.MemUsage.split("/");
      const [networkRx, networkTx] = entry.NetIO.split("/");
      const [blockRead, blockWrite] = entry.BlockIO.split("/");
      return {
        name: entry.Name,
        cpuPercentage: Number(entry.CPUPerc.replace("%", "")),
        rssBytes: parseDockerSize(rss),
        networkRxBytes: parseDockerSize(networkRx),
        networkTxBytes: parseDockerSize(networkTx),
        blockReadBytes: parseDockerSize(blockRead),
        blockWriteBytes: parseDockerSize(blockWrite),
      };
    });
  const homes = {};
  for (const validator of VALIDATORS) {
    const output = await commandOutput("du", [
      "-sk",
      path.join(repositoryRoot, "chain/localnet/.state/container", validator),
    ]);
    homes[validator] = Number(output.split(/\s+/u)[0]) * 1024;
  }
  return { at, containers, homes };
}

async function startResourceSampler() {
  const samples = [await sampleResourcesOnce()];
  let active = true;
  const loop = (async () => {
    while (active) {
      try {
        samples.push(await sampleResourcesOnce());
      } catch {
        // A missed sample is recorded as absence, never a crash.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  })();
  return {
    samples,
    async stop() {
      active = false;
      await loop;
      // Always close with a final sample so even sub-second workloads have
      // a before/after pair.
      samples.push(await sampleResourcesOnce());
      return samples;
    },
  };
}

function resourceDeltasFrom(samples) {
  if (samples.length < 2) {
    throw new Error("resource sampling captured fewer than two samples");
  }
  const first = samples[0];
  const last = samples.at(-1);
  return VALIDATORS.map((validator) => {
    const name = `torium-localnet-${validator}-1`;
    const series = samples
      .map((sample) => sample.containers.find((entry) => entry.name === name))
      .filter(Boolean);
    const cpuValues = series
      .map((entry) => entry.cpuPercentage)
      .filter((value) => Number.isFinite(value));
    const firstEntry = series[0];
    const lastEntry = series.at(-1);
    const delta = (field) => {
      const start = firstEntry?.[field];
      const end = lastEntry?.[field];
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return Math.max(0, end - start);
    };
    return {
      component: validator,
      cpuPercentage:
        cpuValues.length === 0
          ? null
          : Number(
              (cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length).toFixed(6)
            ),
      rssBytes:
        series.length === 0
          ? null
          : Math.max(...series.map((entry) => entry.rssBytes ?? 0)),
      networkRxBytes: delta("networkRxBytes"),
      networkTxBytes: delta("networkTxBytes"),
      blockReadBytes: delta("blockReadBytes"),
      blockWriteBytes: delta("blockWriteBytes"),
      nodeHomeBytes: Math.max(0, (last.homes[validator] ?? 0) - (first.homes[validator] ?? 0)),
    };
  });
}

// --- funding --------------------------------------------------------------

async function fundSender(address, amountBaseUnits) {
  const response = await fetch(`${DEV_FAUCET_URL}/v1/fund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, amountBaseUnits }),
  });
  const payload = await response.json();
  if (response.status !== 201) {
    throw new Error(`dev faucet funding failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

// --- transfer workloads ---------------------------------------------------

function deterministicRecipients(seed, count) {
  const recipients = [];
  for (let index = 0; index < count; index += 1) {
    const digest = createHash("sha256")
      .update(`torium-baseline-recipient/${seed}/${index}`)
      .digest("hex");
    recipients.push(`0x${digest.slice(0, 40)}`);
  }
  return recipients;
}

async function runTransferWorkload(workload) {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  await fundSender(account.address, "20000000000000000000");
  const recipients = deterministicRecipients(options.seed, workload.operationCount);
  const dataset = {
    workloadId: workload.id,
    seed: options.seed,
    transferValueBaseUnits: "1000000000000",
    recipients,
  };

  const baseNonce = hexToNumber(
    await rpc("eth_getTransactionCount", [account.address, "pending"])
  );
  const baseFee = BigInt(
    (await rpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas
  );
  const maxPriorityFeePerGas = 1_000_000_000n;
  const maxFeePerGas = baseFee * 4n + maxPriorityFeePerGas;
  const signed = [];
  for (let index = 0; index < workload.operationCount; index += 1) {
    signed.push(
      await account.signTransaction({
        type: "eip1559",
        chainId: EVM_CHAIN_ID,
        nonce: baseNonce + index,
        gas: 21_000n,
        maxFeePerGas,
        maxPriorityFeePerGas,
        to: recipients[index],
        value: 1_000_000_000_000n,
      })
    );
  }

  const sampler = await startResourceSampler();
  const startHeight = hexToNumber(await rpc("eth_blockNumber"));
  const startedAtMilliseconds = Date.now();
  const startedAt = nowIso();

  const samples = new Array(workload.operationCount);
  let cursor = 0;
  async function workOne() {
    for (;;) {
      const index = cursor;
      if (index >= workload.operationCount) return;
      cursor += 1;
      samples[index] = await submitAndTrack(signed[index]);
    }
  }
  const workers = [];
  for (let worker = 0; worker < workload.concurrency; worker += 1) {
    workers.push(workOne());
  }
  await Promise.all(workers);

  const endedAtMilliseconds = Date.now();
  const endedAt = nowIso();
  const resourceSamples = await sampler.stop();
  let endHeight = hexToNumber(await rpc("eth_blockNumber"));
  for (const sample of samples) {
    if (sample.blockNumber && sample.blockNumber > endHeight) {
      endHeight = sample.blockNumber;
    }
  }

  const rawSamples = {
    caseId: `${workload.id}-run-1`,
    workloadId: workload.id,
    startedAtMilliseconds,
    endedAtMilliseconds,
    samples: samples.map((sample) => sample.record),
  };
  const summarized = summarizeCaseSamples(rawSamples);
  const chainMetrics = await collectChainMetrics(startHeight, endHeight);

  return {
    run: {
      startedAt,
      endedAt,
      startHeight,
      endHeight,
      cosmosChainId: "torium-localnet-1",
      evmChainId: EVM_CHAIN_ID,
      topology: "canonical-four-validator-combined-localnet",
    },
    cases: [summarized],
    chainMetrics,
    rpcMetrics: emptyRpcMetrics(),
    resourceDeltas: resourceDeltasFrom(resourceSamples),
    stateGrowth: {
      nodeHomeBytesDelta: resourceDeltasFrom(resourceSamples).reduce(
        (sum, delta) => sum + (delta.nodeHomeBytes ?? 0),
        0
      ),
      databaseBytesDelta: null,
      storageGrowthBytesPerDay: null,
      indexerLagBlocks: null,
      diskIops: null,
      diskIoLatencyMilliseconds: null,
    },
    artifactsPayloads: [
      { kind: "raw-transaction-samples", name: "raw-transaction-samples.json", body: rawSamples },
      { kind: "resource-samples", name: "resource-samples.json", body: resourceSamples },
      { kind: "dataset", name: "dataset.json", body: dataset },
    ],
    dataset,
  };
}

async function submitAndTrack(rawTransaction) {
  const submittedAt = performance.now();
  let hash;
  try {
    hash = await rpc("eth_sendRawTransaction", [rawTransaction]);
  } catch (error) {
    return {
      record: { outcome: "submission-failed", included: false },
      blockNumber: null,
      error: error.message,
    };
  }
  const acknowledgementLatencyMilliseconds = performance.now() - submittedAt;
  const deadline = performance.now() + 60_000;
  let inclusionLatencyMilliseconds;
  let blockNumber = null;
  while (performance.now() < deadline) {
    const transaction = await rpc("eth_getTransactionByHash", [hash]);
    if (transaction?.blockNumber) {
      inclusionLatencyMilliseconds = performance.now() - submittedAt;
      blockNumber = hexToNumber(transaction.blockNumber);
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (inclusionLatencyMilliseconds === undefined) {
    return {
      record: { outcome: "dropped", included: false, acknowledgementLatencyMilliseconds },
      blockNumber: null,
    };
  }
  let receipt = null;
  let receiptLatencyMilliseconds;
  while (performance.now() < deadline) {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      receiptLatencyMilliseconds = Math.max(
        performance.now() - submittedAt,
        inclusionLatencyMilliseconds
      );
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (!receipt) {
    return {
      record: { outcome: "dropped", included: false, acknowledgementLatencyMilliseconds },
      blockNumber: null,
    };
  }
  const succeeded = receipt.status === "0x1";
  return {
    record: {
      outcome: succeeded ? "success" : "unexpected-revert",
      included: true,
      acknowledgementLatencyMilliseconds,
      inclusionLatencyMilliseconds,
      receiptLatencyMilliseconds,
      gasUsed: hexToNumber(receipt.gasUsed),
    },
    blockNumber,
  };
}

function summaryOf(values) {
  if (values.length === 0) {
    return { sampleCount: 0, minimum: null, p50: null, p95: null, maximum: null, mean: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile) =>
    sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const round = (value) => Number(value.toFixed(6));
  return {
    sampleCount: sorted.length,
    minimum: round(sorted[0]),
    p50: round(nearestRank(0.5)),
    p95: round(nearestRank(0.95)),
    maximum: round(sorted.at(-1)),
    mean: round(total / sorted.length),
  };
}

async function collectChainMetrics(startHeight, endHeight) {
  const blocks = [];
  for (let height = startHeight; height <= endHeight; height += 1) {
    blocks.push(await rpc("eth_getBlockByNumber", [`0x${height.toString(16)}`, false]));
  }
  let contiguous = true;
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index].parentHash !== blocks[index - 1].hash) contiguous = false;
  }
  const gasValues = blocks.map((block) => hexToNumber(block.gasUsed));
  const commitIntervals = [];
  for (let index = 1; index < blocks.length; index += 1) {
    commitIntervals.push(
      (hexToNumber(blocks[index].timestamp) - hexToNumber(blocks[index - 1].timestamp)) * 1000
    );
  }
  const averageBlockGasUsed =
    gasValues.length === 0
      ? null
      : Number((gasValues.reduce((sum, value) => sum + value, 0) / gasValues.length).toFixed(6));
  const targetGas = protocol.consensus.block.targetGas;
  const maxGas = protocol.consensus.block.maxGas;
  return {
    blockSampleCount: blocks.length,
    averageBlockGasUsed,
    maximumBlockGasUsed: gasValues.length === 0 ? null : Math.max(...gasValues),
    targetGasUtilization:
      averageBlockGasUsed === null ? null : Number((averageBlockGasUsed / targetGas).toFixed(6)),
    limitGasUtilization:
      averageBlockGasUsed === null ? null : Number((averageBlockGasUsed / maxGas).toFixed(6)),
    commitIntervalMilliseconds: summaryOf(commitIntervals),
    blockRangeContiguous: contiguous,
    finalityModel: "cometbft-committed-block",
    jsonRpcFinalizedTag: "latest-committed-cometbft-state",
    jsonRpcSafeStateQueries: "unsupported-until-conformance-proves-otherwise",
    rpcAcceptanceGuaranteesRetention: false,
  };
}

function emptyRpcMetrics() {
  return {
    httpRequestCount: 0,
    httpSuccessCount: 0,
    httpErrorCount: 0,
    httpTimeoutCount: 0,
    jsonRpcCallCount: 0,
    callSuccessCount: 0,
    callErrorCount: 0,
    callTimeoutCount: 0,
    batchCount: 0,
    perMethodCounts: [],
    responseBytes: 0,
    latencyMilliseconds: summaryOf([]),
  };
}

// --- RPC workload ---------------------------------------------------------

async function runRpcWorkload(workload) {
  // Seed recent state out-of-band via the dev faucet so receipt and log
  // queries have a real recent transaction to read.
  const probe = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const funding = await fundSender(probe.address, "1000000000000000000");
  const recentTransactionHash = funding.transactionHash;

  const latest = hexToNumber(await rpc("eth_blockNumber"));
  const fromBlock = `0x${Math.max(1, latest - 20).toString(16)}`;
  const methodCall = (method, index) => {
    switch (method) {
      case "eth_getBlockByNumber":
        return [method, [`0x${Math.max(1, latest - (index % 10)).toString(16)}`, false]];
      case "eth_getBalance":
        return [method, [probe.address, "latest"]];
      case "eth_getTransactionReceipt":
        return [method, [recentTransactionHash]];
      case "eth_getLogs":
        return [method, [{ fromBlock, toBlock: "latest" }]];
      case "eth_feeHistory":
        return [method, ["0x4", "latest", [50]]];
      default:
        throw new Error(`unplanned method ${method}`);
    }
  };

  const perMethodCounts = new Map();
  const latencies = [];
  let responseBytes = 0;
  let httpSuccessCount = 0;
  let httpErrorCount = 0;
  let callSuccessCount = 0;
  let callErrorCount = 0;

  const sampler = await startResourceSampler();
  const startHeight = hexToNumber(await rpc("eth_blockNumber"));
  const startedAt = nowIso();
  const startedAtMilliseconds = Date.now();
  const rawRequests = [];

  // Five single-call HTTP requests, one per planned method.
  for (const method of workload.methods) {
    const [name, params] = methodCall(method, 0);
    jsonRpcIdentifier += 1;
    const payload = { jsonrpc: "2.0", id: jsonRpcIdentifier, method: name, params };
    const { parsed, elapsed, bytes } = await rpcRequest(payload);
    latencies.push(elapsed);
    responseBytes += bytes;
    httpSuccessCount += 1;
    if (parsed.error) callErrorCount += 1;
    else callSuccessCount += 1;
    perMethodCounts.set(name, (perMethodCounts.get(name) ?? 0) + 1);
    rawRequests.push({ kind: "single", method: name, elapsedMilliseconds: elapsed, bytes });
  }

  // One batch HTTP request with exactly the planned batch size.
  const batch = [];
  for (let index = 0; index < workload.exactBatchSize; index += 1) {
    const method = workload.methods[index % workload.methods.length];
    const [name, params] = methodCall(method, index);
    jsonRpcIdentifier += 1;
    batch.push({ jsonrpc: "2.0", id: jsonRpcIdentifier, method: name, params });
    perMethodCounts.set(name, (perMethodCounts.get(name) ?? 0) + 1);
  }
  const batchResult = await rpcRequest(batch);
  latencies.push(batchResult.elapsed);
  responseBytes += batchResult.bytes;
  httpSuccessCount += 1;
  for (const entry of batchResult.parsed) {
    if (entry.error) callErrorCount += 1;
    else callSuccessCount += 1;
  }
  rawRequests.push({
    kind: "batch",
    calls: batch.length,
    elapsedMilliseconds: batchResult.elapsed,
    bytes: batchResult.bytes,
  });

  const endedAtMilliseconds = Date.now();
  const endedAt = nowIso();
  const resourceSamples = await sampler.stop();
  const endHeight = hexToNumber(await rpc("eth_blockNumber"));

  const httpRequestCount = workload.httpRequestCount;
  const jsonRpcCallCount = workload.jsonRpcCallCount;
  const elapsedMilliseconds = endedAtMilliseconds - startedAtMilliseconds;
  const round = (value) => Number(value.toFixed(6));
  const rpcCase = {
    caseType: "rpc",
    caseId: `${workload.id}-run-1`,
    workloadId: workload.id,
    elapsedMilliseconds,
    httpRequestCount,
    jsonRpcCallCount,
    httpRequestsPerSecond: round(httpRequestCount / (elapsedMilliseconds / 1000)),
    jsonRpcCallsPerSecond: round(jsonRpcCallCount / (elapsedMilliseconds / 1000)),
    latencyMilliseconds: summaryOf(latencies),
    limitations: [
      "exploratory-local-summary-only",
      "no-p99-or-formal-confidence-claim",
    ],
  };

  const rawSamples = {
    caseId: rpcCase.caseId,
    workloadId: workload.id,
    startedAtMilliseconds,
    endedAtMilliseconds,
    requests: rawRequests,
  };
  const dataset = {
    workloadId: workload.id,
    seed: options.seed,
    methods: workload.methods,
    recentTransactionHash,
    logsFromBlock: fromBlock,
  };

  return {
    run: {
      startedAt,
      endedAt,
      startHeight: Math.min(startHeight, endHeight),
      endHeight: Math.max(startHeight, endHeight),
      cosmosChainId: "torium-localnet-1",
      evmChainId: EVM_CHAIN_ID,
      topology: "canonical-four-validator-combined-localnet",
    },
    cases: [rpcCase],
    chainMetrics: {
      blockSampleCount: 0,
      averageBlockGasUsed: null,
      maximumBlockGasUsed: null,
      targetGasUtilization: null,
      limitGasUtilization: null,
      commitIntervalMilliseconds: summaryOf([]),
      blockRangeContiguous: true,
      finalityModel: "cometbft-committed-block",
      jsonRpcFinalizedTag: "latest-committed-cometbft-state",
      jsonRpcSafeStateQueries: "unsupported-until-conformance-proves-otherwise",
      rpcAcceptanceGuaranteesRetention: false,
    },
    rpcMetrics: {
      httpRequestCount,
      httpSuccessCount,
      httpErrorCount,
      httpTimeoutCount: 0,
      jsonRpcCallCount,
      callSuccessCount,
      callErrorCount,
      callTimeoutCount: 0,
      batchCount: workload.batchCount,
      perMethodCounts: [...perMethodCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([method, count]) => ({ method, count })),
      responseBytes,
      latencyMilliseconds: summaryOf(latencies),
    },
    resourceDeltas: resourceDeltasFrom(resourceSamples),
    stateGrowth: {
      nodeHomeBytesDelta: resourceDeltasFrom(resourceSamples).reduce(
        (sum, delta) => sum + (delta.nodeHomeBytes ?? 0),
        0
      ),
      databaseBytesDelta: null,
      storageGrowthBytesPerDay: null,
      indexerLagBlocks: null,
      diskIops: null,
      diskIoLatencyMilliseconds: null,
    },
    artifactsPayloads: [
      { kind: "raw-rpc-samples", name: "raw-rpc-samples.json", body: rawSamples },
      { kind: "resource-samples", name: "resource-samples.json", body: resourceSamples },
      { kind: "dataset", name: "dataset.json", body: dataset },
    ],
    dataset,
  };
}

// --- assembly -------------------------------------------------------------

async function effectiveConfigArtifact(artifactsDirRelative) {
  const configDir = path.join(
    repositoryRoot,
    "chain/localnet/.state/container/validator-0/config"
  );
  // Record the EFFECTIVE settings only: upstream comment blocks are
  // documentation, and their example connection strings trip the secret
  // scanner without describing any real configuration.
  const parts = [];
  for (const file of ["app.toml", "config.toml"]) {
    const raw = await readFile(path.join(configDir, file), "utf8");
    const effective = raw
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
      .join("\n");
    parts.push(`[${file}]\n${effective}`);
  }
  const body = parts.join("\n");
  return {
    kind: "effective-config",
    name: "validator-0-effective-config.toml",
    bodyText: body,
  };
}


// --- archive historical workload (#118, unblocked by #114) -----------------

// Reads the SAME method mix at a spread of history depths through the archive
// gateway. The point is not throughput: it is whether depth costs anything and
// whether genesis-adjacent history resolves at all. A pruning node would fail
// the depth-0 reads outright, which is what makes this an archive measurement
// rather than another recent-state one.
async function runArchiveHistoricalWorkload(workload) {
  const endpointUrl = WORKLOAD_ENDPOINTS[workload.endpoint];
  if (!endpointUrl) {
    throw new Error(`workload ${workload.id} names an unknown endpoint ${workload.endpoint}`);
  }
  // Seed one recent transaction through the canonical RPC so the archive node
  // has fresh state to have retained; the workload itself never writes.
  const probe = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  await fundSender(probe.address, "1000000000000000000");

  const tip = hexToNumber(await rpc("eth_blockNumber", [], endpointUrl));
  if (tip < 4) {
    throw new Error(`archive workload needs a chain with history, tip is ${tip}`);
  }
  // Depth fraction 0 is the oldest queryable height (1, since genesis carries no
  // block), and 1 is the tip.
  const heightAt = (fraction) =>
    Math.max(1, Math.min(tip, Math.round(1 + fraction * (tip - 1))));
  const depths = workload.historicalDepthFractions.map((fraction) => ({
    fraction,
    height: heightAt(fraction),
  }));

  const methodCall = (method, height) => {
    const tag = `0x${height.toString(16)}`;
    switch (method) {
      case "eth_getBlockByNumber":
        return [method, [tag, false]];
      case "eth_getBalance":
        return [method, [probe.address, tag]];
      case "eth_getTransactionCount":
        return [method, [probe.address, tag]];
      case "eth_getStorageAt":
        return [method, ["0x0000000000000000000000000000000000000000", "0x0", tag]];
      case "eth_getLogs":
        return [method, [{ fromBlock: tag, toBlock: tag }]];
      default:
        throw new Error(`unplanned archive method ${method}`);
    }
  };

  const perMethodCounts = new Map();
  const latencies = [];
  const byDepth = new Map(depths.map(({ fraction }) => [fraction, []]));
  let responseBytes = 0;
  let httpSuccessCount = 0;
  let callSuccessCount = 0;
  let callErrorCount = 0;
  const rawRequests = [];

  const sampler = await startResourceSampler();
  const startHeight = tip;
  const startedAt = nowIso();
  const startedAtMilliseconds = Date.now();

  // One single-call HTTP request per planned method, all at the deepest history.
  const deepest = depths[0];
  for (const method of workload.methods) {
    const [name, params] = methodCall(method, deepest.height);
    jsonRpcIdentifier += 1;
    const { parsed, elapsed, bytes } = await rpcRequest(
      { jsonrpc: "2.0", id: jsonRpcIdentifier, method: name, params },
      endpointUrl
    );
    latencies.push(elapsed);
    byDepth.get(deepest.fraction).push(elapsed);
    responseBytes += bytes;
    httpSuccessCount += 1;
    if (parsed.error) {
      // A refusal or a pruned height is a failed archive measurement, not a
      // slow one: report it instead of averaging it away.
      callErrorCount += 1;
      throw new Error(
        `${name} at historical height ${deepest.height} failed through ${workload.endpoint}: ${JSON.stringify(parsed.error)}`
      );
    }
    callSuccessCount += 1;
    perMethodCounts.set(name, (perMethodCounts.get(name) ?? 0) + 1);
    rawRequests.push({
      kind: "single",
      method: name,
      height: deepest.height,
      depthFraction: deepest.fraction,
      elapsedMilliseconds: elapsed,
      bytes,
    });
  }

  // One batch spread evenly across every planned depth, so depth cost is
  // measured inside a single request rather than across noisy separate ones.
  const batch = [];
  const batchDepths = [];
  for (let index = 0; index < workload.exactBatchSize; index += 1) {
    const method = workload.methods[index % workload.methods.length];
    const depth = depths[index % depths.length];
    const [name, params] = methodCall(method, depth.height);
    jsonRpcIdentifier += 1;
    batch.push({ jsonrpc: "2.0", id: jsonRpcIdentifier, method: name, params });
    batchDepths.push(depth);
    perMethodCounts.set(name, (perMethodCounts.get(name) ?? 0) + 1);
  }
  const batchResult = await rpcRequest(batch, endpointUrl);
  latencies.push(batchResult.elapsed);
  responseBytes += batchResult.bytes;
  httpSuccessCount += 1;
  for (const [index, entry] of batchResult.parsed.entries()) {
    if (entry.error) {
      callErrorCount += 1;
      throw new Error(
        `batched call at depth ${batchDepths[index].fraction} (height ${batchDepths[index].height}) failed: ${JSON.stringify(entry.error)}`
      );
    }
    callSuccessCount += 1;
  }
  // The batch shares one HTTP round trip, so per-depth latency is attributed as
  // the batch's mean per call — recorded as such rather than pretending each
  // call was timed separately.
  const perCall = batchResult.elapsed / batch.length;
  for (const depth of batchDepths) {
    byDepth.get(depth.fraction).push(perCall);
  }
  rawRequests.push({
    kind: "batch",
    calls: batch.length,
    depthFractions: workload.historicalDepthFractions,
    elapsedMilliseconds: batchResult.elapsed,
    perCallMeanMilliseconds: Number(perCall.toFixed(6)),
    bytes: batchResult.bytes,
  });

  const endedAtMilliseconds = Date.now();
  const endedAt = nowIso();
  const resourceSamples = await sampler.stop();
  const endHeight = hexToNumber(await rpc("eth_blockNumber", [], endpointUrl));

  const elapsedMilliseconds = endedAtMilliseconds - startedAtMilliseconds;
  const round = (value) => Number(value.toFixed(6));
  const rpcCase = {
    caseType: "rpc",
    caseId: `${workload.id}-run-1`,
    workloadId: workload.id,
    elapsedMilliseconds,
    httpRequestCount: workload.httpRequestCount,
    jsonRpcCallCount: workload.jsonRpcCallCount,
    httpRequestsPerSecond: round(workload.httpRequestCount / (elapsedMilliseconds / 1000)),
    jsonRpcCallsPerSecond: round(workload.jsonRpcCallCount / (elapsedMilliseconds / 1000)),
    latencyMilliseconds: summaryOf(latencies),
    limitations: [
      "exploratory-local-summary-only",
      "no-p99-or-formal-confidence-claim",
      "batched per-depth latency is the batch mean per call, not an individually timed call",
    ],
  };

  const dataset = {
    workloadId: workload.id,
    seed: options.seed,
    endpoint: workload.endpoint,
    endpointUrl,
    methods: workload.methods,
    chainTip: tip,
    depths,
    latencyByDepthMilliseconds: [...byDepth.entries()]
      .sort(([left], [right]) => left - right)
      .map(([fraction, samples]) => ({
        depthFraction: fraction,
        height: depths.find((depth) => depth.fraction === fraction).height,
        latencyMilliseconds: summaryOf(samples),
      })),
    oldestQueryableHeightProven: depths[0].height,
  };

  return {
    run: {
      startedAt,
      endedAt,
      startHeight: Math.min(startHeight, endHeight),
      endHeight: Math.max(startHeight, endHeight),
      cosmosChainId: "torium-localnet-1",
      evmChainId: EVM_CHAIN_ID,
      topology: "canonical-four-validator-localnet-plus-private-archive-indexer-behind-gateway",
    },
    cases: [rpcCase],
    chainMetrics: {
      blockSampleCount: 0,
      averageBlockGasUsed: null,
      maximumBlockGasUsed: null,
      targetGasUtilization: null,
      limitGasUtilization: null,
      commitIntervalMilliseconds: summaryOf([]),
      blockRangeContiguous: true,
      finalityModel: "cometbft-committed-block",
      jsonRpcFinalizedTag: "latest-committed-cometbft-state",
      jsonRpcSafeStateQueries: "unsupported-until-conformance-proves-otherwise",
      rpcAcceptanceGuaranteesRetention: false,
    },
    rpcMetrics: {
      httpRequestCount: workload.httpRequestCount,
      httpSuccessCount,
      httpErrorCount: 0,
      httpTimeoutCount: 0,
      jsonRpcCallCount: workload.jsonRpcCallCount,
      callSuccessCount,
      callErrorCount,
      callTimeoutCount: 0,
      batchCount: workload.batchCount,
      perMethodCounts: [...perMethodCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([method, count]) => ({ method, count })),
      responseBytes,
      latencyMilliseconds: summaryOf(latencies),
    },
    resourceDeltas: resourceDeltasFrom(resourceSamples),
    stateGrowth: {
      nodeHomeBytesDelta: resourceDeltasFrom(resourceSamples).reduce(
        (sum, delta) => sum + (delta.nodeHomeBytes ?? 0),
        0
      ),
      databaseBytesDelta: null,
      storageGrowthBytesPerDay: null,
      indexerLagBlocks: null,
      diskIops: null,
      diskIoLatencyMilliseconds: null,
    },
    artifactsPayloads: [
      {
        kind: "raw-rpc-samples",
        name: "raw-rpc-samples.json",
        body: {
          caseId: rpcCase.caseId,
          workloadId: workload.id,
          startedAtMilliseconds,
          endedAtMilliseconds,
          requests: rawRequests,
        },
      },
      { kind: "resource-samples", name: "resource-samples.json", body: resourceSamples },
      { kind: "dataset", name: "dataset.json", body: dataset },
    ],
    dataset,
  };
}

async function runWorkload(workload) {
  console.log(`running workload ${workload.id} (scenario ${workload.scenario})`);
  const outcome = workload.id.startsWith("native-transfer-")
    ? await runTransferWorkload(workload)
    : workload.id === "archive-historical-read-mix"
      ? await runArchiveHistoricalWorkload(workload)
      : await runRpcWorkload(workload);

  const runName = options.label ? `${workload.id}-${options.label}` : workload.id;
  const artifactsDirRelative = path.posix.join(
    options.resultsDir,
    "artifacts",
    runName
  );
  await mkdir(path.join(repositoryRoot, artifactsDirRelative), { recursive: true });

  const artifacts = [];
  const pendingWrites = [];
  // Artifacts are STAGED, not written, until provenance has been collected.
  // Provenance describes the source tree that produced the measurement; writing
  // committed artifact files first would dirty that tree and make every re-run
  // of an already-committed workload self-report `dirtyWorktree: true`, which is
  // how a clean re-run came to look like a patched one.
  const writeArtifact = async (kind, name, content) => {
    const relativePath = path.posix.join(artifactsDirRelative, name);
    pendingWrites.push({ relativePath, content });
    artifacts.push({
      kind,
      relativePath,
      sha256: sha256(Buffer.isBuffer(content) ? content : Buffer.from(content)),
      containsSecrets: false,
    });
  };

  for (const payload of outcome.artifactsPayloads) {
    await writeArtifact(payload.kind, payload.name, `${JSON.stringify(payload.body, null, 2)}\n`);
  }
  const effectiveConfig = await effectiveConfigArtifact(artifactsDirRelative);
  await writeArtifact(effectiveConfig.kind, effectiveConfig.name, effectiveConfig.bodyText);
  const runnerBytes = await readFile(path.join(repositoryRoot, RUNNER_RELATIVE_PATH));
  artifacts.push({
    kind: "runner",
    relativePath: RUNNER_RELATIVE_PATH,
    sha256: sha256(runnerBytes),
    containsSecrets: false,
  });
  const genesisBytes = await readFile(
    path.join(repositoryRoot, "chain/genesis/localnet/genesis.json")
  );
  artifacts.push({
    kind: "genesis",
    relativePath: "chain/genesis/localnet/genesis.json",
    sha256: sha256(genesisBytes),
    containsSecrets: false,
  });

  const effectiveConfigSha256 = artifacts.find(
    ({ kind }) => kind === "effective-config"
  ).sha256;
  const datasetSha256 = artifacts.find(({ kind }) => kind === "dataset").sha256;
  const { provenance, patchContent } = await collectProvenance(
    workload,
    datasetSha256,
    effectiveConfigSha256
  );
  // Provenance is fixed; the staged artifacts can now hit disk.
  for (const pending of pendingWrites) {
    await writeFile(path.join(repositoryRoot, pending.relativePath), pending.content);
  }
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
    status: "complete-local",
    planVersion: plan.performanceVersion,
    provenance,
    run: outcome.run,
    cases: outcome.cases,
    chainMetrics: outcome.chainMetrics,
    rpcMetrics: outcome.rpcMetrics,
    resourceDeltas: outcome.resourceDeltas,
    stateGrowth: outcome.stateGrowth,
    observations: {
      bottlenecks: [
        {
          component: "validator-0",
          signal: "single published RPC endpoint serves all workload traffic",
          evidence:
            "workloads target 127.0.0.1:8545, which only validator-0 publishes; the other validators serve consensus only",
          severity: "informational",
        },
      ],
      failureCliffs: [],
      regressionEvaluation: null,
    },
    artifacts,
    capacityClaims: {
      public: false,
      safeTps: null,
      safeRpcRequestsPerSecond: null,
      billOfMaterialsReady: false,
    },
    limitations: [
      "single-run local smoke on a Docker Desktop VM; no formal confidence interval, no p99, no capacity claim",
      "commit intervals derive from EVM block timestamps with one-second resolution",
      "resource deltas come from docker stats sampling (~250ms cadence) and du-based node-home byte deltas",
      "dirtyWorktree reflects tracked modifications only; freshly generated result artifacts are untracked at run time",
    ],
  };

  const resultPath = path.join(
    repositoryRoot,
    options.resultsDir,
    `${runName}.result.json`
  );
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${path.relative(repositoryRoot, resultPath)}`);
  return resultPath;
}

// --- main -----------------------------------------------------------------

const chainId = await rpc("eth_chainId");
if (hexToNumber(chainId) !== EVM_CHAIN_ID) {
  console.error(`localnet chain id mismatch: ${chainId}`);
  process.exit(1);
}

const selected =
  options.workload === "all"
    ? plan.activeWorkloads
    : plan.activeWorkloads.filter(({ id }) => id === options.workload);
if (selected.length === 0) {
  console.error(`unknown workload ${options.workload}`);
  process.exit(64);
}
for (const workload of selected) {
  await runWorkload(workload);
}
console.log("baseline run complete; validate with:");
console.log("  node chain/performance/validate-performance-v0.mjs --committed-results");
