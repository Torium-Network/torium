import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(suiteDirectory, "../../..");
const localnetDirectory = resolve(repositoryRoot, "chain/localnet");
const localnet = resolve(localnetDirectory, "torium-localnet");
const composeFile = resolve(localnetDirectory, "compose.yaml");
const manifest = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "chain/genesis/localnet/manifest.json"),
    "utf8"
  )
);
const protocol = JSON.parse(
  readFileSync(resolve(repositoryRoot, "chain/config/protocol-v1.json"), "utf8")
);
const toolchain = JSON.parse(
  readFileSync(resolve(repositoryRoot, "chain/toolchain.json"), "utf8")
);
const rpcURL = "http://127.0.0.1:8545";
const foundryImage = toolchain.contracts.foundry.image;
const artifactsDirectory = resolve(suiteDirectory, ".artifacts");
const reportPath = resolve(artifactsDirectory, "latest-report.json");

const report = {
  schemaVersion: 1,
  result: "running",
  network: "canonical-four-validator-localnet",
  checks: {},
};
let localnetTouched = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const redactedArgs = [...args];
    const sensitiveValues = [];
    for (let index = 0; index < redactedArgs.length - 1; index += 1) {
      if (redactedArgs[index] === "--private-key") {
        sensitiveValues.push(redactedArgs[index + 1]);
        redactedArgs[index + 1] = "<redacted>";
      }
    }
    let diagnostic = result.stderr || result.stdout;
    for (const sensitiveValue of sensitiveValues) {
      diagnostic = diagnostic.replaceAll(sensitiveValue, "<redacted>");
    }
    throw new Error(
      `${command} ${redactedArgs.join(" ")} failed (${result.status}): ${diagnostic}`
    );
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function cast(args) {
  return execute("docker", [
    "run",
    "--rm",
    "--network",
    "host",
    "--entrypoint",
    "cast",
    foundryImage,
    ...args,
  ]).stdout;
}

function createDataTransactions({
  dataBytes,
  startNonce,
  count,
  gasLimit,
  maxFee,
  tip,
}) {
  const helper = resolve(
    repositoryRoot,
    "chain/app/scripts/run-in-toolchain.sh"
  );
  const output = execute(helper, [
    "go",
    "run",
    "../tests/fees/txgen.go",
    "--chain-id",
    manifest.evm_chain_id.toString(),
    "--to",
    recipientAddress,
    "--start-nonce",
    startNonce.toString(),
    "--count",
    count.toString(),
    "--data-bytes",
    dataBytes.toString(),
    "--gas-limit",
    gasLimit.toString(),
    "--max-fee",
    maxFee.toString(),
    "--tip",
    tip.toString(),
  ]).stdout;
  return JSON.parse(output);
}

function createReplayTransaction({ mode, signingChainId, nonce, gasPrice }) {
  const helper = resolve(
    repositoryRoot,
    "chain/app/scripts/run-in-toolchain.sh"
  );
  const args = [
    "go",
    "run",
    "../tests/fees/replaygen.go",
    "--mode",
    mode,
    "--to",
    recipientAddress,
    "--nonce",
    nonce.toString(),
    "--gas-price",
    gasPrice.toString(),
  ];
  if (signingChainId !== undefined) {
    args.push("--signing-chain-id", signingChainId.toString());
  }
  return JSON.parse(execute(helper, args).stdout);
}

async function rpcAllowError(method, params = []) {
  try {
    const response = await fetch(rpcURL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    return body.error
      ? { ok: false, error: body.error }
      : { ok: true, result: body.result };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "transport-rejection",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function rpc(method, params = []) {
  const response = await rpcAllowError(method, params);
  if (!response.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}

async function sendRaw(rawTransaction) {
  return rpcAllowError("eth_sendRawTransaction", [rawTransaction]);
}

function asBigInt(value) {
  return BigInt(value);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForReceipt(hash, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await rpcAllowError("eth_getTransactionReceipt", [hash]);
    if (response.ok && response.result) return response.result;
    await delay(1_000);
  }
  throw new Error(`receipt timeout for ${hash}`);
}

async function blockNumber() {
  return asBigInt(await rpc("eth_blockNumber"));
}

async function waitForBlock(target, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await blockNumber()) >= target) return;
    await delay(1_000);
  }
  throw new Error(`block height did not reach ${target}`);
}

function makeTransaction({
  to = recipientAddress,
  nonce,
  value,
  gasLimit = 21_000,
  maxFee,
  tip,
  legacy = false,
  accessList = false,
}) {
  const args = [
    "mktx",
    to,
    "--value",
    value.toString(),
    "--gas-limit",
    gasLimit.toString(),
    "--gas-price",
    maxFee.toString(),
    "--nonce",
    nonce.toString(),
    "--private-key",
    privateKey,
    "--rpc-url",
    rpcURL,
  ];
  if (tip !== undefined) args.push("--priority-gas-price", tip.toString());
  if (legacy) args.push("--legacy");
  if (accessList) args.push("--access-list", "[]");
  return cast(args);
}

function makeContractCreation({ nonce, bytecode, gasLimit, maxFee, tip }) {
  return cast([
    "mktx",
    "--gas-limit",
    gasLimit.toString(),
    "--gas-price",
    maxFee.toString(),
    "--priority-gas-price",
    tip.toString(),
    "--nonce",
    nonce.toString(),
    "--private-key",
    privateKey,
    "--rpc-url",
    rpcURL,
    "--create",
    bytecode,
  ]);
}

async function sendAndRequire(raw, label) {
  const response = await sendRaw(raw);
  assert(
    response.ok,
    `${label} was rejected: ${JSON.stringify(response.error)}`
  );
  const receipt = await waitForReceipt(response.result);
  assert(receipt.status === "0x1", `${label} receipt failed`);
  return { hash: response.result, receipt };
}

function balance(address) {
  return asBigInt(cast(["balance", address, "--rpc-url", rpcURL]));
}

function totalSupply() {
  const output = cast([
    "call",
    protocol.nativeAsset.solidityInterface.address,
    "totalSupply()(uint256)",
    "--rpc-url",
    rpcURL,
  ]);
  return asBigInt(output.split(/\s+/u)[0]);
}

const privateKey = `0x${createHash("sha256")
  .update("torium/localnet/valueless-fixture/v1/account/deployer")
  .digest("hex")}`;
const deployerAddress = manifest.development_accounts.find(
  (account) => account.name === "deployer"
).evm_address;
const recipientAddress = manifest.development_accounts.find(
  (account) => account.name === "sdk-user"
).evm_address;

try {
  console.log("[1/7] reset and start the canonical local-only network");
  localnetTouched = true;
  execute(localnet, ["reset", "--backend", "container", "--yes"]);
  const readiness = JSON.parse(
    execute(localnet, [
      "start",
      "--backend",
      "container",
      "--timeout",
      "90",
      "--json",
    ]).stdout
  );
  assert(
    readiness.ready && readiness.allValidatorsReady,
    "localnet is not ready"
  );
  assert(
    cast(["wallet", "address", "--private-key", privateKey]).toLowerCase() ===
      deployerAddress.toLowerCase(),
    "deterministic fee-test signer differs from the manifest"
  );
  const genesisSupply = totalSupply();
  const latestAtStart = await rpc("eth_getBlockByNumber", ["latest", false]);
  assert(
    asBigInt(latestAtStart.baseFeePerGas) >=
      asBigInt(protocol.fees.minimumBaseFeeBaseUnitsPerGas),
    "runtime base fee is below the protocol floor"
  );

  console.log("[2/7] exercise estimate/simulation and type 0/1/2 envelopes");
  const estimatedGas = asBigInt(
    await rpc("eth_estimateGas", [
      { from: deployerAddress, to: recipientAddress, value: "0x1" },
    ])
  );
  assert(estimatedGas === 21_000n, `EOA transfer estimate was ${estimatedGas}`);
  const simulated = await rpc("eth_call", [
    { from: deployerAddress, to: recipientAddress, value: "0x1" },
    "latest",
  ]);
  assert(simulated === "0x", `EOA simulation returned ${simulated}`);

  const legacyRaw = makeTransaction({
    nonce: 0,
    value: 1n,
    maxFee: 2_000_000_000n,
    legacy: true,
  });
  assert(
    !legacyRaw.startsWith("0x01") && !legacyRaw.startsWith("0x02"),
    "legacy raw envelope is typed"
  );
  const legacy = await sendAndRequire(legacyRaw, "type-0 legacy transaction");
  assert(
    legacy.receipt.type === "0x0",
    `legacy receipt type is ${legacy.receipt.type}`
  );

  const accessListRaw = makeTransaction({
    nonce: 1,
    value: 2n,
    maxFee: 2_000_000_000n,
    legacy: true,
    accessList: true,
  });
  assert(
    accessListRaw.startsWith("0x01"),
    "access-list transaction was not encoded as type 1"
  );
  const accessList = await sendAndRequire(
    accessListRaw,
    "type-1 access-list transaction"
  );
  assert(
    accessList.receipt.type === "0x1",
    `access-list receipt type is ${accessList.receipt.type}`
  );

  const senderBefore = balance(deployerAddress);
  const recipientBefore = balance(recipientAddress);
  const dynamicRaw = makeTransaction({
    nonce: 2,
    value: 7n,
    maxFee: 2_000_000_000n,
    tip: 100_000_000n,
  });
  assert(
    dynamicRaw.startsWith("0x02"),
    "dynamic-fee transaction was not encoded as type 2"
  );
  const dynamic = await sendAndRequire(
    dynamicRaw,
    "type-2 dynamic-fee transaction"
  );
  assert(
    dynamic.receipt.type === "0x2",
    `dynamic receipt type is ${dynamic.receipt.type}`
  );
  const senderAfter = balance(deployerAddress);
  const recipientAfter = balance(recipientAddress);
  const chargedFee =
    asBigInt(dynamic.receipt.gasUsed) *
    asBigInt(dynamic.receipt.effectiveGasPrice);
  assert(
    senderBefore - senderAfter === chargedFee + 7n,
    "sender debit does not equal value plus receipt fee"
  );
  assert(
    recipientAfter - recipientBefore === 7n,
    "recipient credit does not equal transaction value"
  );

  const wrongChainID = BigInt(manifest.evm_chain_id) + 1n;
  const wrongChainFixture = createReplayTransaction({
    mode: "wrong-chain",
    signingChainId: wrongChainID,
    nonce: 3,
    gasPrice: 2_000_000_000n,
  });
  assert(
    wrongChainFixture.protected,
    "wrong-chain fixture is not EIP-155 protected"
  );
  assert(
    asBigInt(wrongChainFixture.chainId) === wrongChainID,
    "wrong-chain fixture used an unexpected replay domain"
  );
  const wrongChain = await sendRaw(wrongChainFixture.raw);
  assert(
    !wrongChain.ok,
    "transaction signed for a different EIP-155 chain ID was accepted"
  );
  assert(
    wrongChain.error.code === -32000,
    "wrong-chain rejection code changed"
  );
  assert(
    /incorrect chain-id.*expected.*got/iu.test(wrongChain.error.message),
    `wrong-chain transaction failed for an unexpected reason: ${wrongChain.error.message}`
  );

  const unprotectedFixture = createReplayTransaction({
    mode: "unprotected",
    nonce: 3,
    gasPrice: 2_000_000_000n,
  });
  assert(
    !unprotectedFixture.protected,
    "unprotected fixture unexpectedly uses EIP-155"
  );
  assert(
    asBigInt(unprotectedFixture.chainId) === 0n,
    "unprotected fixture has a chain ID"
  );
  const unprotected = await sendRaw(unprotectedFixture.raw);
  assert(!unprotected.ok, "unprotected legacy transaction was accepted");
  assert(
    unprotected.error.code === -32000,
    "unprotected rejection code changed"
  );
  assert(
    /only replay-protected.*EIP-155.*allowed/iu.test(unprotected.error.message),
    `unprotected transaction failed for an unexpected reason: ${unprotected.error.message}`
  );

  const blobFixture = createReplayTransaction({
    mode: "blob",
    signingChainId: BigInt(manifest.evm_chain_id),
    nonce: 3,
    gasPrice: 2_000_000_000n,
  });
  assert(blobFixture.type === 3, "blob fixture is not transaction type 3");
  const blob = await sendRaw(blobFixture.raw);
  if (!blob.ok) {
    assert(
      blob.error.code === -32000,
      "blob transaction rejection code changed"
    );
    assert(
      /blob|EIP-4844|type 3/iu.test(blob.error.message),
      `blob transaction failed for an unexpected reason: ${blob.error.message}`
    );
  }

  const setCodeFixture = createReplayTransaction({
    mode: "set-code",
    signingChainId: BigInt(manifest.evm_chain_id),
    nonce: 3,
    gasPrice: 2_000_000_000n,
  });
  assert(
    setCodeFixture.type === 4,
    "set-code fixture is not transaction type 4"
  );
  const setCode = await sendRaw(setCodeFixture.raw);
  if (!setCode.ok) {
    assert(
      setCode.error.code === -32000,
      "set-code transaction rejection code changed"
    );
    assert(
      /set.?code|EIP-7702|type 4/iu.test(setCode.error.message),
      `set-code transaction failed for an unexpected reason: ${setCode.error.message}`
    );
  }
  if (blob.ok || setCode.ok) await delay(5_000);
  const [blobReceipt, setCodeReceipt] = await Promise.all([
    blob.ok ? rpc("eth_getTransactionReceipt", [blob.result]) : null,
    setCode.ok ? rpc("eth_getTransactionReceipt", [setCode.result]) : null,
  ]);
  const nonceAfterReplayRejections = asBigInt(
    await rpc("eth_getTransactionCount", [deployerAddress, "latest"])
  );
  assert(
    nonceAfterReplayRejections === 3n &&
      blobReceipt === null &&
      setCodeReceipt === null,
    "a rejected replay-domain or unsupported-envelope fixture changed canonical state"
  );

  // Creation code returns the four-byte runtime `JUMPDEST PUSH1(0) JUMP`.
  // Calls consume their complete gas limit and fail deterministically without
  // growing state, making block-gas saturation independent of calldata size.
  const burnerCreationBytecode = "0x6004600c60003960046000f35b600056";
  const burnerRaw = makeContractCreation({
    nonce: 3,
    bytecode: burnerCreationBytecode,
    gasLimit: 300_000,
    maxFee: 2_000_000_000n,
    tip: 100_000_000n,
  });
  const burnerDeployment = await sendAndRequire(
    burnerRaw,
    "gas-burner contract deployment"
  );
  const burnerAddress = burnerDeployment.receipt.contractAddress;
  assert(
    burnerAddress,
    "gas-burner deployment did not return a contract address"
  );
  report.checks.envelopes = {
    estimateGas: estimatedGas.toString(),
    simulation: "passed",
    types: [legacy.receipt.type, accessList.receipt.type, dynamic.receipt.type],
    chargedFee: chargedFee.toString(),
    contractDeployment: burnerDeployment.hash,
  };
  report.checks.replayProtection = {
    canonicalChainId: manifest.evm_chain_id.toString(),
    wrongChainId: wrongChainFixture.chainId,
    wrongChainRejected: true,
    wrongChainError: wrongChain.error,
    unprotectedRejected: true,
    unprotectedError: unprotected.error,
    nextCanonicalNonceUnaffected: nonceAfterReplayRejections.toString(),
  };
  report.checks.unsupportedEnvelopes = {
    blobType: blobFixture.type,
    blobRpcAcknowledgedBeforeCheckTx: blob.ok,
    blobRetainedOrProposed: false,
    blobError: blob.ok ? null : blob.error,
    setCodeType: setCodeFixture.type,
    setCodeRpcAcknowledgedBeforeCheckTx: setCode.ok,
    setCodeRetainedOrProposed: false,
    setCodeError: setCode.ok ? null : setCode.error,
    antePolicyUnitTest: "chain/app/ante_test.go",
  };

  console.log("[3/7] reject a transaction below the current base fee");
  const latestBeforeUnderprice = await rpc("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const currentBaseFee = asBigInt(latestBeforeUnderprice.baseFeePerGas);
  const underpricedRaw = makeTransaction({
    nonce: 4,
    value: 1n,
    maxFee: currentBaseFee - 1n,
    tip: 1n,
  });
  const underpriced = await sendRaw(underpricedRaw);
  let underpricedRetained = false;
  if (underpriced.ok) {
    // Cosmos EVM may return a hash before asynchronous app-mempool CheckTx
    // finishes. RPC acknowledgement is intentionally not a retention promise.
    await delay(5_000);
    const receipt = await rpc("eth_getTransactionReceipt", [
      underpriced.result,
    ]);
    const pendingNonce = asBigInt(
      await rpc("eth_getTransactionCount", [deployerAddress, "pending"])
    );
    underpricedRetained = receipt !== null || pendingNonce !== 4n;
  }
  assert(
    !underpricedRetained,
    "transaction below the base fee was retained or proposed"
  );
  report.checks.underpriced = {
    rpcAcknowledgedBeforeCheckTx: underpriced.ok,
    retainedOrProposed: false,
    error: underpriced.ok ? null : underpriced.error.message,
  };

  console.log(
    "[4/7] halt quorum and prove exact local same-nonce replacement rules"
  );
  execute("docker", [
    "compose",
    "--file",
    composeFile,
    "stop",
    "validator-1",
    "validator-2",
    "validator-3",
  ]);
  await delay(3_000);
  const haltedAt = await blockNumber();
  await delay(5_000);
  assert(
    (await blockNumber()) === haltedAt,
    "three stopped validators did not halt consensus"
  );

  const initialMaxFee = currentBaseFee * 2n;
  const initialTip = 100_000_000n;
  const originalRaw = makeTransaction({
    nonce: 4,
    value: 1n,
    maxFee: initialMaxFee,
    tip: initialTip,
  });
  const belowBumpRaw = makeTransaction({
    nonce: 4,
    value: 2n,
    maxFee: (initialMaxFee * 109n) / 100n,
    tip: (initialTip * 109n) / 100n,
  });
  const replacementRaw = makeTransaction({
    nonce: 4,
    value: 3n,
    maxFee: (initialMaxFee * 110n) / 100n,
    tip: (initialTip * 110n) / 100n,
  });
  const original = await sendRaw(originalRaw);
  const belowBump = await sendRaw(belowBumpRaw);
  const replacement = await sendRaw(replacementRaw);
  assert(
    original.ok,
    `original replacement candidate failed: ${JSON.stringify(original.error)}`
  );
  assert(!belowBump.ok, "9% same-nonce fee bump was accepted");
  assert(
    replacement.ok,
    `10% same-nonce fee bump failed: ${JSON.stringify(replacement.error)}`
  );

  const pendingNonceAfterReplacement = asBigInt(
    await rpc("eth_getTransactionCount", [deployerAddress, "pending"])
  );
  const gapRaw = makeTransaction({
    nonce: 6,
    value: 4n,
    maxFee: initialMaxFee,
    tip: initialTip,
  });
  const gap = await sendRaw(gapRaw);
  assert(
    gap.ok,
    `nonce-gap candidate failed admission: ${JSON.stringify(gap.error)}`
  );
  await delay(2_000);
  const latestNonceWithGap = asBigInt(
    await rpc("eth_getTransactionCount", [deployerAddress, "latest"])
  );
  const pendingNonceWithGap = asBigInt(
    await rpc("eth_getTransactionCount", [deployerAddress, "pending"])
  );
  const queuedGapLookup = await rpc("eth_getTransactionByHash", [gap.result]);
  assert(
    latestNonceWithGap === 4n,
    "nonce-gap candidate changed committed nonce"
  );
  if (queuedGapLookup !== null) {
    assert(
      queuedGapLookup.hash.toLowerCase() === gap.result.toLowerCase(),
      "nonce-gap lookup returned the wrong transaction"
    );
  }

  const gapFillRaw = makeTransaction({
    nonce: 5,
    value: 5n,
    maxFee: initialMaxFee,
    tip: initialTip,
  });
  const gapFill = await sendRaw(gapFillRaw);
  assert(gapFill.ok, `nonce-gap fill failed: ${JSON.stringify(gapFill.error)}`);
  await delay(2_000);
  const pendingNonceAfterGapFill = asBigInt(
    await rpc("eth_getTransactionCount", [deployerAddress, "pending"])
  );
  const [gapFillLookup, promotedGapLookup] = await Promise.all([
    rpc("eth_getTransactionByHash", [gapFill.result]),
    rpc("eth_getTransactionByHash", [gap.result]),
  ]);
  report.checks.replacement = {
    scope: "receiving-node-only",
    configuredPercent: 10,
    belowBumpRejected: true,
    exactBumpAccepted: true,
    belowBumpError: belowBump.error,
    pendingNonceAfterReplacement: pendingNonceAfterReplacement.toString(),
  };
  report.checks.nonceGap = {
    scope: "receiving-node-admission-and-commit",
    gapNonce: 6,
    committedNonceWhileHalted: latestNonceWithGap.toString(),
    pendingNonceBeforeGapFill: pendingNonceWithGap.toString(),
    queuedTransactionVisibleByHash: queuedGapLookup !== null,
    byHashVisibilityIsNotExecutionEligibility: true,
    pendingNonceAfterGapFill: pendingNonceAfterGapFill.toString(),
    fillVisibleByHashBeforeCommit: gapFillLookup !== null,
    gapVisibleByHashAfterFillBeforeCommit: promotedGapLookup !== null,
    pendingTagIsNotUsedAsExecutionEligibility: true,
  };
  report.checks.capacity = {
    configuredAccountExecutableSlots: protocol.mempool.accountExecutableSlots,
    configuredGlobalExecutableSlots: protocol.mempool.globalExecutableSlots,
    configuredAccountQueuedSlots: protocol.mempool.accountQueuedSlots,
    configuredGlobalQueuedSlots: protocol.mempool.globalQueuedSlots,
    liveBoundaryStatus: "not-observable-from-default-profile",
    reason:
      "txpool is intentionally disabled and RPC acknowledgement does not guarantee app-mempool retention; capacity boundaries remain config/unit evidence",
  };

  console.log(
    "[5/7] reject oversize input and queue enough valid work to saturate a block"
  );
  const dataMaxFee = currentBaseFee * 4n;
  const dataTip = 100_000_000n;
  const ordinaryTransferGas = 21_000;
  const regularBurnGas = 5_000_000;
  const burnGasLimits = Array.from({ length: 6 }, (_, offset) =>
    offset < 5
      ? regularBurnGas
      : protocol.consensus.block.maxGas -
        ordinaryTransferGas * 3 -
        regularBurnGas * 5
  );
  assert(
    burnGasLimits.at(-1) > ordinaryTransferGas,
    "configured block gas cannot hold the deterministic saturation fixture"
  );
  const burnTransactions = [];
  for (const [offset, gasLimit] of burnGasLimits.entries()) {
    const raw = makeTransaction({
      to: burnerAddress,
      nonce: 7 + offset,
      value: 0n,
      gasLimit,
      maxFee: dataMaxFee,
      tip: dataTip,
    });
    const result = await sendRaw(raw);
    assert(
      result.ok,
      `gas saturation transaction ${offset} was rejected: ${JSON.stringify(result.error)}`
    );
    burnTransactions.push(result.result);
  }
  const validLargeTransactions = createDataTransactions({
    dataBytes: 125_000,
    startNonce: 13,
    count: 1,
    gasLimit: 5_500_000,
    maxFee: dataMaxFee,
    tip: dataTip,
  });
  const dataTransactions = [];
  for (const [offset, raw] of validLargeTransactions.entries()) {
    const result = await sendRaw(raw);
    assert(
      result.ok,
      `large valid transaction ${offset} was rejected: ${JSON.stringify(result.error)}`
    );
    dataTransactions.push(result.result);
  }
  const [oversizedRaw] = createDataTransactions({
    dataBytes: 132_000,
    startNonce: 14,
    count: 1,
    gasLimit: 25_000_000,
    maxFee: dataMaxFee,
    tip: dataTip,
  });
  const oversized = await sendRaw(oversizedRaw);
  assert(!oversized.ok, "EVM transaction above 128 KiB was accepted");
  assert(
    (await blockNumber()) === haltedAt,
    "RPC did not recover after oversized transaction rejection"
  );

  execute("docker", [
    "compose",
    "--file",
    composeFile,
    "start",
    "validator-1",
    "validator-2",
    "validator-3",
  ]);
  // Do not run the full `localnet start` path here: Compose `up` is allowed to
  // recreate validator-0, which would correctly discard its process-local
  // mempool and invalidate this receiving-node replacement proof.
  await waitForBlock(haltedAt + 1n);
  const replacementReceipt = await waitForReceipt(replacement.result);
  assert(
    replacementReceipt.status === "0x1",
    "replacement did not commit successfully"
  );
  const originalReceipt = await rpc("eth_getTransactionReceipt", [
    original.result,
  ]);
  assert(
    originalReceipt === null,
    "replaced transaction unexpectedly committed"
  );
  const [gapFillReceipt, gapReceipt] = await Promise.all([
    waitForReceipt(gapFill.result),
    waitForReceipt(gap.result),
  ]);
  assert(
    gapFillReceipt.status === "0x1" && gapReceipt.status === "0x1",
    "nonce gap and fill did not commit in nonce order"
  );
  const dataReceipts = await Promise.all(
    dataTransactions.map((hash) => waitForReceipt(hash))
  );
  assert(
    dataReceipts.every((receipt) => receipt.status === "0x1"),
    "a saturation transaction failed"
  );

  const burnReceipts = await Promise.all(
    burnTransactions.map((hash) => waitForReceipt(hash))
  );
  assert(
    burnReceipts.every((receipt) => receipt.status === "0x0"),
    "a deterministic out-of-gas saturation call unexpectedly succeeded"
  );

  const blockNumbers = [
    ...new Set(burnReceipts.map((receipt) => receipt.blockNumber)),
  ];
  assert(
    blockNumbers.length === 1,
    "saturation transactions split across blocks"
  );
  const blocks = await Promise.all(
    blockNumbers.map((number) => rpc("eth_getBlockByNumber", [number, false]))
  );
  const saturatedBlock = blocks.reduce((largest, block) =>
    asBigInt(block.gasUsed) > asBigInt(largest.gasUsed) ? block : largest
  );
  const saturatedGas = asBigInt(saturatedBlock.gasUsed);
  assert(
    saturatedGas > BigInt(protocol.consensus.block.targetGas),
    `largest block used ${saturatedGas}, not above target gas`
  );
  assert(
    saturatedGas <= BigInt(protocol.consensus.block.maxGas),
    `block exceeded gas limit: ${saturatedGas}`
  );
  assert(
    saturatedGas === BigInt(protocol.consensus.block.maxGas),
    `saturation fixture used ${saturatedGas}, expected ${protocol.consensus.block.maxGas}`
  );
  assert(
    asBigInt(saturatedBlock.gasLimit) ===
      BigInt(protocol.consensus.block.maxGas),
    "saturated block gas limit differs from the protocol contract"
  );
  const saturatedHeight = asBigInt(saturatedBlock.number);
  await waitForBlock(saturatedHeight + 1n);
  const nextBlock = await rpc("eth_getBlockByNumber", [
    `0x${(saturatedHeight + 1n).toString(16)}`,
    false,
  ]);
  assert(
    asBigInt(nextBlock.baseFeePerGas) > asBigInt(saturatedBlock.baseFeePerGas),
    "base fee did not rise after an above-target block"
  );
  const saturatedHistory = await rpc("eth_feeHistory", [
    "0x1",
    saturatedBlock.number,
    [10, 50, 90],
  ]);
  const expectedSaturatedRatio =
    Number(saturatedGas) / Number(asBigInt(saturatedBlock.gasLimit));
  assert(
    asBigInt(saturatedHistory.oldestBlock) === saturatedHeight,
    "saturated fee history started at the wrong block"
  );
  assert(
    saturatedHistory.gasUsedRatio.length === 1,
    "saturated fee history ratio shape"
  );
  assert(
    saturatedHistory.baseFeePerGas.length === 2,
    "saturated fee history base-fee shape"
  );
  assert(
    saturatedHistory.reward.length === 1,
    "saturated fee history reward shape"
  );
  assert(
    saturatedHistory.reward[0].length === 3,
    "saturated fee history percentile shape"
  );
  assert(
    Math.abs(saturatedHistory.gasUsedRatio[0] - expectedSaturatedRatio) < 1e-12,
    "saturated fee history gas ratio differs from the block"
  );
  assert(
    saturatedHistory.baseFeePerGas[0] === saturatedBlock.baseFeePerGas &&
      saturatedHistory.baseFeePerGas[1] === nextBlock.baseFeePerGas,
    "saturated fee history does not link current and next base fees"
  );

  await waitForBlock(100n, 240);
  const historyHead = await blockNumber();
  const historyHeadTag = `0x${historyHead.toString(16)}`;
  const feeHistory100 = await rpc("eth_feeHistory", [
    "0x64",
    historyHeadTag,
    [50],
  ]);
  const expectedOldestHistoryBlock = historyHead - 99n;
  assert(
    asBigInt(feeHistory100.oldestBlock) === expectedOldestHistoryBlock,
    "100-block fee history started at the wrong block"
  );
  assert(
    feeHistory100.gasUsedRatio.length === 100,
    `100-block fee history returned ${feeHistory100.gasUsedRatio.length} blocks`
  );
  assert(
    feeHistory100.baseFeePerGas.length === 101,
    "100-block fee history base-fee shape"
  );
  assert(
    feeHistory100.reward.length === 100,
    "100-block fee history reward shape"
  );
  const feeHistory101 = await rpcAllowError("eth_feeHistory", [
    "0x65",
    historyHeadTag,
    [50],
  ]);
  assert(
    !feeHistory101.ok,
    "101-block fee history exceeded the configured cap"
  );
  assert(
    feeHistory101.error.code === -32000,
    "101-block fee history error code changed"
  );
  assert(
    /user block count 101 higher than 100/iu.test(feeHistory101.error.message),
    `101-block fee history failed for an unexpected reason: ${feeHistory101.error.message}`
  );
  report.checks.saturation = {
    validLargeTransactions: dataTransactions.length,
    oversizedRejected: true,
    deterministicOutOfGasTransactions: burnTransactions.length,
    blockNumber: saturatedHeight.toString(),
    gasUsed: saturatedGas.toString(),
    targetGas: protocol.consensus.block.targetGas,
    maxGas: protocol.consensus.block.maxGas,
    baseFeeRaisedNextBlock: true,
  };
  report.checks.feeHistory = {
    cap: 100,
    requestedAtExplicitHead: historyHead.toString(),
    oldestBlockFor100: asBigInt(feeHistory100.oldestBlock).toString(),
    blocksReturnedFor100: feeHistory100.gasUsedRatio.length,
    request101: feeHistory101.error,
    saturatedBlock: {
      number: saturatedHeight.toString(),
      fullySaturated: saturatedHistory.gasUsedRatio[0] === 1,
      gasUsedRatio: saturatedHistory.gasUsedRatio[0],
      rewardPercentiles: [10, 50, 90],
      baseFeePerGas: saturatedHistory.baseFeePerGas,
      nextBaseFeeMatched: true,
    },
  };

  console.log(
    "[6/7] reconcile fee accounting and native supply after saturation"
  );
  const finalSupply = totalSupply();
  assert(
    finalSupply === genesisSupply,
    "fee collection or execution changed native supply"
  );
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  assert(
    asBigInt(latest.baseFeePerGas) >=
      asBigInt(protocol.fees.minimumBaseFeeBaseUnitsPerGas),
    "base fee fell below its configured floor"
  );
  report.checks.accounting = {
    senderReceiptReconciled: true,
    feeCollectorUnitTestOwned: "chain/app/localnet/fee_economics_test.go",
    nativeSupplyBefore: genesisSupply.toString(),
    nativeSupplyAfter: finalSupply.toString(),
    baseFeeFloorRespected: true,
  };

  console.log("[7/7] emit the local fee/resource acceptance proof");
  report.result = "passed";
  mkdirSync(artifactsDirectory, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  report.result = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  mkdirSync(artifactsDirectory, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  if (localnetTouched) {
    execute(localnet, ["stop", "--backend", "container"], {
      allowFailure: true,
    });
  }
}
