#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(
  await readFile(join(directory, "protocol-v1.json"), "utf8")
);
const identifiers = JSON.parse(
  await readFile(join(directory, "identifiers.json"), "utf8")
);
const supportMatrix = JSON.parse(
  await readFile(
    join(directory, "../poc/upstream-baseline/support-matrix.json"),
    "utf8"
  )
);
const governance = JSON.parse(
  await readFile(join(directory, "governance-v1.json"), "utf8")
);

const bech32Alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function expandHrp(hrp) {
  return [
    ...[...hrp].map((character) => character.charCodeAt(0) >>> 5),
    0,
    ...[...hrp].map((character) => character.charCodeAt(0) & 31),
  ];
}

function convertBits(bytes, fromBits, toBits, pad) {
  let accumulator = 0;
  let bits = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  for (const byte of bytes) {
    assert.ok(
      byte >= 0 && byte >>> fromBits === 0,
      "invalid convertBits input"
    );
    accumulator = ((accumulator << fromBits) | byte) & maxAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >>> bits) & maxValue);
    }
  }
  if (pad && bits > 0) result.push((accumulator << (toBits - bits)) & maxValue);
  if (!pad) {
    assert.ok(bits < fromBits, "illegal zero padding");
    assert.ok(
      ((accumulator << (toBits - bits)) & maxValue) === 0,
      "non-zero padding"
    );
  }
  return result;
}

function encodeBech32(hrp, bytes) {
  const words = convertBits(bytes, 8, 5, true);
  const values = [...expandHrp(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 1;
  const checksum = Array.from(
    { length: 6 },
    (_, index) => (polymod >>> (5 * (5 - index))) & 31
  );
  return `${hrp}1${[...words, ...checksum]
    .map((word) => bech32Alphabet[word])
    .join("")}`;
}

function decodeBech32(value) {
  assert.equal(value, value.toLowerCase(), "mixed-case Bech32 is invalid");
  const separator = value.lastIndexOf("1");
  assert.ok(
    separator > 0 && separator + 7 <= value.length,
    "invalid Bech32 separator"
  );
  const hrp = value.slice(0, separator);
  const words = [...value.slice(separator + 1)].map((character) => {
    const index = bech32Alphabet.indexOf(character);
    assert.ok(index >= 0, `invalid Bech32 character ${character}`);
    return index;
  });
  assert.equal(
    bech32Polymod([...expandHrp(hrp), ...words]),
    1,
    "invalid Bech32 checksum"
  );
  return {
    hrp,
    bytes: Buffer.from(convertBits(words.slice(0, -6), 5, 8, false)),
  };
}

assert.equal(protocol.$schema, "./protocol-v1.schema.json");
assert.equal(protocol.schemaVersion, 1);
assert.match(protocol.protocolVersion, /^1\.0\.0-local\.[1-9][0-9]*$/u);
assert.equal(protocol.genesisFormatVersion, 1);
assert.equal(protocol.status, "local-development-contract");
assert.equal(
  protocol.sources.identifiers.manifestVersion,
  identifiers.manifestVersion,
  "protocol must consume the current identifier manifest"
);
assert.equal(
  protocol.sources.upstream.commit,
  supportMatrix.baseline.cosmosEvmCommit
);
assert.deepEqual(protocol.sources.governance, {
  path: "./governance-v1.json",
  contractVersion: governance.contractVersion,
});
assert.equal(governance.protocol.version, protocol.protocolVersion);
assert.equal(governance.scope.publicActivationAllowed, false);

const expectedEnvironments = ["localnet", "devnet", "testnet", "mainnet"];
assert.deepEqual(
  protocol.networkProfiles.map((profile) => profile.environment),
  expectedEnvironments
);
assert.deepEqual(
  identifiers.networks.map((network) => network.environment),
  expectedEnvironments
);
for (const profile of protocol.networkProfiles) {
  const network = identifiers.networks.find(
    (candidate) => candidate.environment === profile.environment
  );
  assert.ok(network, `missing identifier network ${profile.environment}`);
  assert.equal(profile.cosmosChainId, network.cosmos.chainId);
  assert.equal(profile.evmChainId, network.evm.chainId);
  assert.equal(profile.evmChainIdHex, network.evm.chainIdHex);
  assert.equal(profile.nativeSymbol, network.nativeCurrencySymbol);
  assert.equal(profile.publicEndpointsAllowed, false);
}
assert.equal(protocol.networkProfiles[0].activation, "active-local-only");
for (const profile of protocol.networkProfiles.slice(1)) {
  assert.match(profile.activation, /inactive/u);
}

assert.equal(protocol.accounts.evmKeyType, "secp256k1");
assert.equal(protocol.accounts.accountBytes, 20);
assert.equal(protocol.accounts.coinType, 60);
assert.equal(protocol.accounts.defaultDerivationPath, "m/44'/60'/0'/0/0");
assert.equal(
  protocol.accounts.publicKeyToAddress,
  "keccak256(uncompressed-secp256k1-public-key-without-0x04)[12:32]"
);
assert.equal(protocol.accounts.relationship, "same-20-bytes-two-encodings");
assert.deepEqual(protocol.accounts.canonical, {
  jsonRpc: "0x-hex",
  sdkAndDocs: "eip55-checksummed-0x",
  cosmosRestAndGrpc: "bech32",
  comparison: "normalized-20-byte-value",
});
assert.deepEqual(
  protocol.accounts.bech32Prefixes,
  identifiers.addressing.cosmos.bech32
);
const checksummedVectors = new Map([
  [
    "0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
  ],
  [
    "52908400098527886e0f7030069857d2e4169ee7",
    "0x52908400098527886E0F7030069857D2E4169EE7",
  ],
  [
    "000000000000000000000000000000000000dead",
    "0x000000000000000000000000000000000000dEaD",
  ],
  [
    "00112233445566778899aabbccddeeff00112233",
    "0x00112233445566778899AABbCCdDeeFf00112233",
  ],
]);
for (const vector of protocol.accounts.testVectors) {
  assert.match(vector.hex, /^0x[0-9a-fA-F]{40}$/u);
  const rawHex = vector.hex.slice(2).toLowerCase();
  assert.equal(
    vector.hex,
    checksummedVectors.get(rawHex),
    "EIP-55 vector drift"
  );
  const bytes = Buffer.from(rawHex, "hex");
  assert.equal(
    encodeBech32(protocol.accounts.bech32Prefixes.account, bytes),
    vector.bech32Account
  );
  const decoded = decodeBech32(vector.bech32Account);
  assert.equal(decoded.hrp, protocol.accounts.bech32Prefixes.account);
  assert.equal(decoded.bytes.length, protocol.accounts.accountBytes);
  assert.deepEqual(decoded.bytes, bytes);
  for (const [field, prefix] of [
    [
      "bech32ValidatorOperator",
      protocol.accounts.bech32Prefixes.validatorOperator,
    ],
    [
      "bech32ValidatorConsensus",
      protocol.accounts.bech32Prefixes.validatorConsensus,
    ],
  ]) {
    assert.equal(encodeBech32(prefix, bytes), vector[field]);
    const roleDecoded = decodeBech32(vector[field]);
    assert.equal(roleDecoded.hrp, prefix);
    assert.equal(roleDecoded.bytes.length, protocol.accounts.accountBytes);
    assert.deepEqual(roleDecoded.bytes, bytes);
  }
}
assert.equal(protocol.accounts.testVectors.length, checksummedVectors.size);
const addressCapability = supportMatrix.capabilities.find(
  (capability) => capability.id === "account.bech32-and-hex-representation"
);
assert.equal(addressCapability.state, "supported");
assert.deepEqual(addressCapability.consumerIssues, [131]);

const baseUnits = BigInt(protocol.nativeAsset.oneDisplayUnitInBaseUnits);
const powerReduction = BigInt(protocol.nativeAsset.powerReduction);
const localSupply = BigInt(protocol.nativeAsset.localnetGenesisSupplyBaseUnits);
assert.equal(protocol.nativeAsset.baseDenom, identifiers.currency.baseDenom);
assert.equal(protocol.nativeAsset.decimals, identifiers.currency.decimals);
assert.equal(protocol.nativeAsset.displayDenom, "TOR");
assert.equal(protocol.nativeAsset.localDisplayDenom, "tTOR");
assert.equal(
  protocol.nativeAsset.canonicalLedger,
  "cosmos-bank-balance-exposed-to-evm"
);
assert.deepEqual(protocol.nativeAsset.consumerSurfaces, [
  "evm-native-value",
  "evm-gas-fees",
  "cosmos-bank",
  "staking",
  "distribution-rewards",
  "governance-deposits",
  "cli-rest-grpc",
  "json-rpc-wallet-explorer-sdk",
  "solidity-native-facade",
]);
assert.equal(baseUnits, 10n ** BigInt(identifiers.currency.decimals));
assert.equal(
  powerReduction,
  baseUnits,
  "one TOR must map to one consensus-power unit"
);
assert.equal(localSupply % baseUnits, 0n);
assert.equal(
  localSupply / baseUnits,
  BigInt(protocol.nativeAsset.localnetGenesisSupplyDisplay)
);
assert.deepEqual(protocol.nativeAsset.issuance, {
  model: "genesis-capped-non-inflationary",
  mintModuleIncluded: false,
  inflationPerYear: "0",
  postGenesisNativeMintingAllowed: false,
  applicationRestriction: "deny-atorium-in-x-bank-mint-coins",
});
assert.deepEqual(protocol.nativeAsset.burns, {
  allowed: true,
  policy: "protocol-authorized-module-paths-only",
  effect: "permanently-reduce-x-bank-total-supply",
  visibility: "committed-bank-burn-events-and-supply-query",
  silentOrReversibleBurnAllowed: false,
});
assert.deepEqual(protocol.nativeAsset.supplyAccounting, {
  totalSupplySource: "x-bank-supply-atorium",
  balanceSource: "x-bank-balance-atorium",
  baseUnits: "unsigned-integer-atorium",
  reconciliationInvariant: "sum-bank-balances-equals-x-bank-total-supply",
  representationConversionChangesSupply: false,
});
assert.deepEqual(protocol.nativeAsset.solidityInterface, {
  kind: "native-werc20-precompile-bank-backed-facade",
  address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  contractOwner: "erc20-module",
  duplicateWrappedSupply: false,
  nativeConversionAllowed: false,
  permissionlessRegistration: false,
  depositBehavior:
    "returns-msg-value-to-caller-and-emits-compatibility-event",
  withdrawBehavior:
    "validates-native-balance-and-emits-compatibility-event-without-transfer",
});
assert.equal(
  protocol.nativeAsset.publicGenesisSupply.status,
  "not-defined-not-publishable"
);
assert.equal(protocol.nativeAsset.publicGenesisSupply.amountBaseUnits, null);
assert.equal(protocol.nativeAsset.publicGenesisSupply.allocation, "not-defined");
assert.equal(protocol.nativeAsset.publicGenesisSupply.approvalRequired, true);
assert.equal(protocol.nativeAsset.publicGenesisSupply.deploymentGateIssue, 127);
assert.deepEqual(protocol.nativeAsset.validatorEconomicsOwnerIssues, [88, 100]);

assert.equal(protocol.consensus.engine, "CometBFT");
assert.equal(protocol.consensus.version, "v0.39.3");
assert.equal(protocol.consensus.targetBlockTimeMs, 2000);
assert.deepEqual(protocol.consensus.block, {
  maxBytes: 5_242_880,
  maxGas: 30_000_000,
  targetGas: 15_000_000,
});
assert.deepEqual(protocol.consensus.transaction, {
  maxEvmEncodedBytes: 131_072,
  maxCosmosEncodedBytes: 262_144,
  maxGasWanted: 25_000_000,
});
assert.equal(
  protocol.consensus.block.targetGas * protocol.fees.elasticityMultiplier,
  protocol.consensus.block.maxGas
);
assert.ok(
  protocol.consensus.transaction.maxGasWanted <= protocol.consensus.block.maxGas
);
assert.ok(
  protocol.consensus.transaction.maxEvmEncodedBytes <=
    protocol.consensus.transaction.maxCosmosEncodedBytes
);
assert.ok(
  protocol.consensus.transaction.maxCosmosEncodedBytes <=
    protocol.consensus.block.maxBytes
);
assert.equal(
  protocol.consensus.finality.ethereumBeaconFinalityEquivalent,
  false
);
assert.match(protocol.consensus.finality.jsonRpcFinalizedTag, /cometbft/u);

assert.deepEqual(protocol.validatorEconomics, {
  status: "ratified-local-only",
  publicActivation: {
    allowed: false,
    gateIssue: 127,
    requiresFreshGenesisReview: true,
  },
  staking: {
    bondDenom: "atorium",
    powerReduction: "1000000000000000000",
    minimumSelfDelegationBaseUnits: "1000000000000000000",
    maximumActiveValidators: 100,
    maximumEntries: 7,
    historicalEntries: 10_000,
    unbondingTimeSeconds: 1_814_400,
  },
  commission: {
    minimumRate: "0.05",
    maximumRate: "0.20",
    maximumDailyChangeRate: "0.01",
  },
  distribution: {
    funding: "transaction-fees-and-existing-bank-balances-only",
    communityTax: "0.02",
    withdrawAddressEnabled: true,
    nativeMintingAllowed: false,
  },
  slashing: {
    signedBlocksWindow: 100,
    minimumSignedPerWindow: "0.50",
    downtimeJailDurationSeconds: 600,
    downtimeSlashFraction: "0.01",
    doubleSignSlashFraction: "0.05",
    doubleSignJail: "permanent-tombstone",
  },
  evidence: {
    acceptedMisbehavior: ["duplicate-vote", "light-client-attack"],
    maximumAgeBlocks: 100_000,
    maximumAgeDurationSeconds: 172_800,
    maximumBytesPerBlock: 1_048_576,
  },
  lifecycle: {
    validatorCreation:
      "permissionless-on-chain-transaction-subject-to-policy",
    validatorRemoval: "stake-driven-unbonding-no-admin-delete",
    supportedOperations: [
      "create-validator",
      "edit-validator",
      "delegate",
      "redelegate",
      "undelegate",
      "withdraw-delegation-rewards",
      "withdraw-validator-commission",
      "unjail",
    ],
    querySurfaces: [
      "cli",
      "cosmos-rest",
      "grpc",
      "evm-staking-distribution-slashing-precompiles",
      "explorer-indexer-readable-events",
    ],
    privilegedNativeMintRequired: false,
  },
  accounting: {
    baseUnit: "integer-atorium",
    powerConversion: "floor-staked-atorium-divided-by-1e18",
    delegationShareDust:
      "less-than-or-equal-to-one-base-unit-per-delegation-conversion",
    invariants: [
      "sum-bank-balances-equals-x-bank-total-supply",
      "bonded-and-not-bonded-pools-reconcile-with-staking-state",
      "validator-delegator-shares-equal-sum-of-delegation-shares",
      "rewards-and-commission-never-create-native-supply",
    ],
  },
});
assert.equal(
  BigInt(protocol.validatorEconomics.staking.powerReduction),
  powerReduction
);
assert.equal(
  BigInt(protocol.validatorEconomics.staking.minimumSelfDelegationBaseUnits),
  powerReduction
);

assert.equal(protocol.fees.pricingModel, "eip1559");
assert.deepEqual(protocol.fees, {
  profile: "local-development-only",
  pricingModel: "eip1559",
  enabledAtHeight: 1,
  initialBaseFeeBaseUnitsPerGas: "1000000000",
  minimumBaseFeeBaseUnitsPerGas: "1000000000",
  baseFeeChangeDenominator: 8,
  elasticityMultiplier: 2,
  minimumGasMultiplier: "0.5",
  minimumPriorityFeeBaseUnitsPerGas: "1",
  validatorMinimumGasPrice: "0atorium",
  feeCollectorDisposition: "cosmos-fee-collector-then-distribution",
  baseFeeBurned: false,
  ethereumBurnSemanticsClaimed: false,
  unusedGasRefunded: true,
  nativeSupplyChangedByFeeCollection: false,
  parameterChangeControl: {
    consensusAuthority: "cosmos-governance-module-account",
    ownerIssue: 106,
    directOperatorMutationAllowed: false,
  },
  publicProfile: {
    status: "not-defined-not-activatable",
    activationAllowed: false,
    gateIssue: 127,
    requiredEvidenceIssues: [118, 120],
  },
  economicsValidationOwnerIssue: 105,
});
assert.ok(
  BigInt(protocol.fees.initialBaseFeeBaseUnitsPerGas) >=
    BigInt(protocol.fees.minimumBaseFeeBaseUnitsPerGas)
);

assert.deepEqual(
  protocol.transactions.evm.acceptedTypes.map(
    (transaction) => transaction.type
  ),
  [0, 1, 2]
);
assert.deepEqual(protocol.transactions.evm.acceptedTypes, [
  { type: 0, name: "legacy", requiredEips: [155] },
  { type: 1, name: "access-list", requiredEips: [2718, 2930] },
  { type: 2, name: "dynamic-fee", requiredEips: [1559, 2718] },
]);
assert.deepEqual(
  protocol.transactions.evm.rejectedTypes.map(
    (transaction) => transaction.type
  ),
  [3, 4]
);
assert.deepEqual(protocol.transactions.evm.rejectedTypes, [
  {
    type: 3,
    name: "blob",
    reason: "no Ethereum data-availability or blob fee market",
  },
  {
    type: 4,
    name: "set-code",
    reason:
      "upstream implementation is disabled at admission pending a separate EIP-7702 security decision and conformance gate",
  },
]);
assert.equal(protocol.transactions.evm.allowUnprotectedTransactions, false);
assert.equal(protocol.transactions.evm.chainIdReplayProtectionRequired, true);
assert.equal(protocol.transactions.cosmos.signMode, "SIGN_MODE_DIRECT");
assert.equal(protocol.transactions.cosmos.legacyAminoJsonSigning, false);
assert.equal(protocol.transactions.cosmos.enabled, true);
assert.equal(
  protocol.transactions.cosmos.accountSequenceReplayProtectionRequired,
  true
);
assert.match(protocol.transactions.localnetResetReplayWarning, /replayable/u);

const includedModules = protocol.modules.included;
const excludedModules = protocol.modules.excluded;
assert.deepEqual(includedModules, [
  "auth",
  "bank",
  "consensus",
  "distribution",
  "erc20",
  "evidence",
  "evm",
  "feemarket",
  "genutil",
  "gov",
  "slashing",
  "staking",
  "upgrade",
]);
assert.deepEqual(excludedModules, [
  "authz",
  "circuit",
  "feegrant",
  "ibc",
  "ibc-transfer",
  "mint",
  "vesting",
]);
assert.deepEqual(includedModules, [...includedModules].sort());
assert.deepEqual(excludedModules, [...excludedModules].sort());
assert.equal(new Set(includedModules).size, includedModules.length);
assert.equal(new Set(excludedModules).size, excludedModules.length);
for (const module of [
  "auth",
  "bank",
  "feemarket",
  "gov",
  "staking",
  "upgrade",
  "evm",
]) {
  assert.ok(
    includedModules.includes(module),
    `missing required module ${module}`
  );
}
for (const module of ["ibc", "ibc-transfer", "mint"]) {
  assert.ok(
    excludedModules.includes(module),
    `missing excluded module ${module}`
  );
  assert.ok(
    !includedModules.includes(module),
    `excluded module ${module} is included`
  );
}
assert.deepEqual(protocol.modules.ibcPolicy, {
  runtimeComposition: "omitted",
  upstreamDependencyMayRemain: true,
  genesisSectionAllowed: false,
  messageRoutesAllowed: false,
  channelsAllowed: false,
  relayersAllowed: false,
  ibcPrecompilesAllowed: false,
  bridgeUxAllowed: false,
});
assert.deepEqual(protocol.modules.erc20Policy, {
  moduleIncluded: true,
  enableErc20: true,
  permissionlessRegistration: false,
  nativeTokenPairAtGenesis: true,
  nativePrecompileAddress:
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  nativePairContractOwner: "module",
  nativeRepresentation: "bank-backed-facade-no-duplicate-supply",
  nativeConversionAllowed: false,
  upstreamExamplePairsAllowed: false,
  dynamicPrecompilesAtGenesisAllowed: false,
});
assert.equal(
  protocol.modules.erc20Policy.nativePrecompileAddress,
  protocol.nativeAsset.solidityInterface.address
);

const activePrecompileAddresses = protocol.evm.activeCustomPrecompiles.map(
  (precompile) => precompile.address
);
assert.equal(protocol.evm.executionFork, "Prague");
assert.equal(protocol.evm.permissionlessContractCreation, true);
assert.equal(protocol.evm.permissionlessContractCalls, true);
assert.deepEqual(protocol.evm.extraEips, []);
assert.equal(protocol.evm.historyServeWindowBlocks, 8192);
const inactivePrecompileAddresses =
  protocol.evm.explicitlyInactivePrecompiles.map(
    (precompile) => precompile.address
  );
assert.deepEqual(
  activePrecompileAddresses,
  [...activePrecompileAddresses].sort()
);
assert.deepEqual(
  protocol.evm.activeCustomPrecompiles.map((precompile) => precompile.name),
  [
    "p256",
    "bech32",
    "staking",
    "distribution",
    "bank",
    "governance",
    "slashing",
  ]
);
assert.equal(
  new Set(activePrecompileAddresses).size,
  activePrecompileAddresses.length
);
assert.ok(
  !activePrecompileAddresses.some((address) =>
    inactivePrecompileAddresses.includes(address)
  )
);
assert.deepEqual(inactivePrecompileAddresses, [
  "0x0000000000000000000000000000000000000802",
  "0x0000000000000000000000000000000000000807",
]);
assert.equal(protocol.evm.upstreamExamplePreinstallsAllowed, false);

assert.equal(protocol.mempool.cometBftType, "app");
assert.deepEqual(protocol.mempool, {
  profile: "local-development-only",
  cometBftType: "app",
  minimumPriorityFeeBaseUnitsPerGas: 1,
  priceLimitBaseUnitsPerGas: 1,
  priceBumpPercent: 10,
  accountExecutableSlots: 16,
  globalExecutableSlots: 5120,
  accountQueuedSlots: 64,
  globalQueuedSlots: 1024,
  queuedLifetimeSeconds: 10_800,
  includedNonceCacheSize: 4096,
  pendingProposalTimeoutMs: 250,
  checkTxTimeoutMs: 5000,
  insertQueueSize: 5000,
  transactionTrackerEnabled: false,
  cosmosPoolMaxTransactions: 1000,
  maximumEvmTransactionBytes: 131_072,
  maximumCosmosTransactionBytes: 262_144,
  cometReapMaxBytes: 5_242_880,
  cometReapMaxGas: 30_000_000,
  replacementRule:
    "both-fee-cap-and-tip-cap-must-increase-by-at-least-price-bump",
  rpcAcceptanceGuaranteesRetention: false,
  networkWideReplacementGuaranteed: false,
  parameterChangeControl: "versioned-coordinated-node-configuration-rollout",
  abuseModel: {
    underpricedTransactions: "rejected-before-proposal",
    oversizedEvmTransactions: "rejected-above-131072-encoded-bytes",
    oversizedCosmosTransactions: "rejected-above-262144-encoded-bytes",
    oversizedRpcRequests:
      "rejected-above-5242880-body-bytes-or-100-batch-requests",
    stateGrowthGasLowerBoundPerNewSlot: 20_000,
    theoreticalNewSlotsAtTargetGas: 750,
    theoreticalNewSlotsAtBlockGasLimit: 1500,
    modelExcludesTransactionCallAndColdAccessOverhead: true,
    sustainedStateGrowthBounded: false,
    publicCapacityClaimed: false,
    capacityEvidenceOwnerIssues: [118, 120],
  },
});
assert.equal(
  protocol.mempool.maximumEvmTransactionBytes,
  protocol.consensus.transaction.maxEvmEncodedBytes
);
assert.equal(
  protocol.mempool.maximumCosmosTransactionBytes,
  protocol.consensus.transaction.maxCosmosEncodedBytes
);
assert.equal(
  protocol.mempool.cometReapMaxBytes,
  protocol.consensus.block.maxBytes
);
assert.equal(
  protocol.mempool.cometReapMaxGas,
  protocol.consensus.block.maxGas
);
assert.equal(
  protocol.mempool.minimumPriorityFeeBaseUnitsPerGas.toString(),
  protocol.fees.minimumPriorityFeeBaseUnitsPerGas
);
assert.equal(
  protocol.mempool.abuseModel.theoreticalNewSlotsAtTargetGas,
  protocol.consensus.block.targetGas /
    protocol.mempool.abuseModel.stateGrowthGasLowerBoundPerNewSlot
);
assert.equal(
  protocol.mempool.abuseModel.theoreticalNewSlotsAtBlockGasLimit,
  protocol.consensus.block.maxGas /
    protocol.mempool.abuseModel.stateGrowthGasLowerBoundPerNewSlot
);
assert.equal(protocol.mempool.rpcAcceptanceGuaranteesRetention, false);
assert.equal(protocol.mempool.networkWideReplacementGuaranteed, false);
assert.equal(
  supportMatrix.capabilities.find(
    (capability) => capability.id === "mempool.same-nonce-fee-bump-local"
  ).state,
  "partial"
);

const namespaceGroups = [
  protocol.rpc.defaultNamespaces,
  protocol.rpc.operatorOnlyNamespaces,
  protocol.rpc.disabledNamespaces,
];
assert.deepEqual(protocol.rpc.defaultNamespaces, ["eth", "net", "web3"]);
assert.deepEqual(protocol.rpc.operatorOnlyNamespaces, ["debug", "txpool"]);
assert.deepEqual(protocol.rpc.disabledNamespaces, ["miner", "personal"]);
assert.deepEqual(protocol.rpc.limits, {
  ethCallGasCap: 25_000_000,
  ethCallTimeoutMs: 5000,
  feeHistoryBlockCap: 100,
  getLogsResultCap: 10_000,
  getLogsBlockRangeCap: 10_000,
  httpBodyBytes: 5_242_880,
  httpBatchRequests: 100,
  httpBatchResponseBytes: 25_000_000,
});
assert.deepEqual(protocol.rpc.webSocket, {
  browserWildcardOriginAllowed: false,
  replayMissedSubscriptions: false,
  clientReconnectAndBackfillRequired: true,
});
const allNamespaces = namespaceGroups.flat();
assert.equal(new Set(allNamespaces).size, allNamespaces.length);
assert.equal(
  protocol.rpc.limits.ethCallGasCap,
  protocol.consensus.transaction.maxGasWanted
);
assert.equal(protocol.rpc.limits.feeHistoryBlockCap, 100);
assert.equal(protocol.rpc.webSocket.browserWildcardOriginAllowed, false);
assert.equal(protocol.rpc.webSocket.replayMissedSubscriptions, false);
assert.equal(protocol.rpc.allowInsecureUnlock, false);

const expectedPorts = {
  rest: 1317,
  pprof: 6060,
  jsonRpcMetrics: 6065,
  gethMetrics: 8100,
  jsonRpcHttp: 8545,
  jsonRpcWebSocket: 8546,
  grpc: 9090,
  grpcWeb: 9091,
  p2p: 26656,
  cometRpc: 26657,
  abci: 26658,
  cometMetrics: 26660,
};
assert.deepEqual(protocol.ports.defaults, expectedPorts);
assert.equal(
  new Set(Object.values(expectedPorts)).size,
  Object.keys(expectedPorts).length
);
assert.equal(protocol.ports.nodeOffset, 100);
assert.equal(protocol.ports.hostPublishing, "loopback-only");
assert.equal(
  protocol.ports.containerBinding,
  "all-interfaces-inside-isolated-local-network"
);

for (const requiredOwner of [
  "protocol",
  "trustAndFinality",
  "threatModel",
  "genesis",
  "nodeComposition",
  "nativeAsset",
  "feeEconomics",
  "upgradesAndGovernance",
  "conformance",
  "validatorLifecycle",
  "rpcProfiles",
]) {
  assert.ok(Number.isInteger(protocol.owners[requiredOwner]));
}
assert.deepEqual(protocol.owners, {
  protocol: 86,
  trustAndFinality: 88,
  threatModel: 90,
  genesis: 91,
  nodeComposition: 94,
  nativeAsset: 104,
  feeEconomics: 105,
  upgradesAndGovernance: 106,
  conformance: 107,
  validatorLifecycle: 100,
  rpcProfiles: 114,
});
assert.match(protocol.compatibility.publicGenesisResetRule, /never reuse/u);
assert.ok(protocol.compatibility.breaking.length >= 5);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      protocolVersion: protocol.protocolVersion,
      identifierManifestVersion: identifiers.manifestVersion,
      environments: expectedEnvironments,
      addressVectors: protocol.accounts.testVectors.length,
      includedModules: includedModules.length,
      activeCustomPrecompiles: activePrecompileAddresses.length,
      ports: Object.keys(expectedPorts).length,
      publicEndpointsAllowed: false,
    },
    null,
    2
  )}\n`
);
