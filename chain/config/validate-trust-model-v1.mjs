#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const trust = JSON.parse(
  await readFile(join(directory, "trust-model-v1.json"), "utf8")
);
const protocol = JSON.parse(
  await readFile(join(directory, "protocol-v1.json"), "utf8")
);
const toolchain = JSON.parse(
  await readFile(join(directory, "../toolchain.json"), "utf8")
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

function quorum(totalPower) {
  return Math.floor((2 * totalPower) / 3) + 1;
}

function stage(id) {
  const value = trust.stages.find((candidate) => candidate.id === id);
  assert.ok(value, `missing trust stage ${id}`);
  return value;
}

function scenario(id) {
  const value = trust.faultScenarios.find((candidate) => candidate.id === id);
  assert.ok(value, `missing fault scenario ${id}`);
  return value;
}

assert.equal(trust.$schema, "./trust-model-v1.schema.json");
assert.equal(trust.schemaVersion, 1);
assert.match(trust.modelVersion, /^1\.0\.0-local\.[1-9][0-9]*$/u);
assert.equal(trust.status, "local-development-contract");
assert.equal(trust.protocol.path, "./protocol-v1.json");
assert.equal(trust.protocol.version, protocol.protocolVersion);
assert.equal(trust.protocol.consensusEngine, protocol.consensus.engine);
assert.equal(trust.protocol.consensusVersion, protocol.consensus.version);
assert.equal(trust.protocol.consensusVersion, toolchain.chain.cometBft);
assert.equal(governance.protocol.version, trust.protocol.version);
assert.equal(governance.scope.publicActivationAllowed, false);

const sourceByName = new Map(
  trust.sources.map((source) => [source.name, source])
);
assert.equal(sourceByName.size, trust.sources.length);
assert.deepEqual(sourceByName.get("CometBFT consensus specification"), {
  name: "CometBFT consensus specification",
  version: "v0.39.3",
  commit: "49b82838fcca442b2445f76605c101609ed04130",
  url: "https://github.com/cometbft/cometbft/blob/v0.39.3/spec/consensus/consensus.md",
});
assert.deepEqual(sourceByName.get("CometBFT evidence specification"), {
  name: "CometBFT evidence specification",
  version: "v0.39.3",
  commit: "49b82838fcca442b2445f76605c101609ed04130",
  url: "https://github.com/cometbft/cometbft/blob/v0.39.3/spec/consensus/evidence.md",
});
for (const name of [
  "Cosmos SDK slashing module",
  "Cosmos SDK evidence module",
]) {
  const source = sourceByName.get(name);
  assert.ok(source, `missing source ${name}`);
  assert.equal(source.version, toolchain.chain.cosmosSdk);
  assert.equal(source.commit, "046046a6731ddc00bca29193f5f0529d7017b3e3");
  assert.match(source.url, /\/blob\/v0\.54\.3\/x\//u);
}

assert.deepEqual(trust.consensusAssumptions, {
  quorumRule: "strictly-more-than-two-thirds-total-voting-power",
  integerQuorumFormula: "floor(2*totalVotingPower/3)+1",
  safetyAssumption: "byzantine-voting-power-strictly-less-than-one-third",
  livenessAssumption:
    "strictly-more-than-two-thirds-timely-honest-and-mutually-reachable-voting-power",
  networkModel:
    "partial-synchrony-with-eventual-message-delivery-and-increasing-round-timeouts",
  validatorCountIsSecurityBoundary: false,
  votingPowerIsSecurityBoundary: true,
  oneThirdOrMoreCanHaltOrCensor: true,
  oneThirdOrMoreMayViolateSafety: true,
  evidenceIsBestEffortAfterAssumptionViolation: true,
});

const expectedLivenessParameters = [
  "consensus.timeout_propose",
  "consensus.timeout_propose_delta",
  "consensus.timeout_prevote",
  "consensus.timeout_prevote_delta",
  "consensus.timeout_precommit",
  "consensus.timeout_precommit_delta",
  "consensus.timeout_commit",
];
const expectedLocalLivenessValues = [
  "1s",
  "500ms",
  "500ms",
  "250ms",
  "500ms",
  "250ms",
  "2s",
];
assert.deepEqual(
  trust.livenessParameterOwners.map(({ parameter }) => parameter),
  expectedLivenessParameters
);
for (const [index, parameter] of trust.livenessParameterOwners.entries()) {
  assert.equal(parameter.status, "unratified");
  assert.deepEqual(parameter.ownerIssues, [93, 118, 119]);
  assert.equal(parameter.localValue, expectedLocalLivenessValues[index]);
  assert.equal(parameter.localStatus, "active-local-unratified");
  assert.deepEqual(parameter.ratificationIssues, [118, 119]);
  assert.ok(parameter.rationale.length > 20);
}

const expectedEnvironments = ["localnet", "devnet", "testnet", "mainnet"];
assert.deepEqual(
  trust.stages.map((candidate) => candidate.environment),
  expectedEnvironments
);
assert.equal(
  new Set(trust.stages.map(({ id }) => id)).size,
  trust.stages.length
);
for (const trustStage of trust.stages) {
  const network = protocol.networkProfiles.find(
    (profile) => profile.environment === trustStage.environment
  );
  assert.ok(network, `missing protocol profile ${trustStage.environment}`);
  assert.equal(trustStage.activation, network.activation);
  assert.equal(trustStage.validatorCount, trustStage.votingPower.length);
  assert.equal(trustStage.decentralizationClaimAllowed, false);
  assert.deepEqual(Object.keys(trustStage.controls).sort(), [
    "censor",
    "halt",
    "rewrite",
    "upgrade",
  ]);
  for (const control of Object.values(trustStage.controls)) {
    assert.ok(control.actors.length > 0);
    assert.ok(control.capability.length > 20);
  }

  const calculatedTotal = trustStage.votingPower.reduce(
    (sum, validator) => sum + validator.power,
    0
  );
  assert.equal(calculatedTotal, trustStage.totalVotingPower);
  assert.equal(
    new Set(trustStage.votingPower.map(({ validator }) => validator)).size,
    trustStage.votingPower.length
  );
  if (calculatedTotal > 0) {
    assert.equal(trustStage.commitQuorumPower, quorum(calculatedTotal));
    assert.ok(
      calculatedTotal - trustStage.maximumGuaranteedUnavailablePower >=
        trustStage.commitQuorumPower,
      `${trustStage.id} does not tolerate its declared unavailable power`
    );
  } else {
    assert.equal(trustStage.commitQuorumPower, 0);
    assert.equal(trustStage.maximumGuaranteedUnavailablePower, 0);
  }
}

const localnet = stage("localnet-authority");
assert.equal(localnet.environment, "localnet");
assert.equal(localnet.validatorCount, 4);
assert.equal(localnet.independentOperatorCount, 0);
assert.equal(localnet.administrativeTrustDomains, 1);
assert.deepEqual(
  localnet.votingPower.map(({ power }) => power),
  [25, 25, 25, 25]
);
assert.equal(
  new Set(localnet.votingPower.map(({ operator }) => operator)).size,
  1
);
assert.equal(localnet.totalVotingPower, 100);
assert.equal(localnet.commitQuorumPower, 67);
assert.ok(localnet.totalVotingPower - 25 >= localnet.commitQuorumPower);
assert.ok(localnet.totalVotingPower - 50 < localnet.commitQuorumPower);

const privateDevnet = stage("private-devnet-authority");
assert.equal(privateDevnet.activation, "reserved-private-inactive");
assert.equal(privateDevnet.administrativeTrustDomains, 1);
assert.equal(privateDevnet.decentralizationClaimAllowed, false);

const publicReadiness = stage("public-testnet-independent-readiness");
assert.equal(publicReadiness.activation, "reserved-public-inactive");
assert.equal(publicReadiness.readinessOnly, true);
assert.equal(publicReadiness.validatorCount, 7);
assert.equal(publicReadiness.independentOperatorCount, 7);
assert.equal(publicReadiness.administrativeTrustDomains, 7);
assert.equal(
  new Set(publicReadiness.votingPower.map(({ operator }) => operator)).size,
  7
);
assert.deepEqual(
  publicReadiness.votingPower.map(({ power }) => power),
  [15, 15, 14, 14, 14, 14, 14]
);
assert.equal(publicReadiness.maximumGuaranteedUnavailablePower, 30);
for (let first = 0; first < publicReadiness.votingPower.length; first += 1) {
  for (
    let second = first + 1;
    second < publicReadiness.votingPower.length;
    second += 1
  ) {
    const pairPower =
      publicReadiness.votingPower[first].power +
      publicReadiness.votingPower[second].power;
    assert.ok(
      publicReadiness.totalVotingPower - pairPower >=
        publicReadiness.commitQuorumPower,
      "public readiness distribution must tolerate any two validator outages"
    );
    assert.ok(
      pairPower * 3 < publicReadiness.totalVotingPower,
      "any two public readiness validators must remain below one-third power"
    );
  }
}
assert.deepEqual(publicReadiness.readinessGates, {
  minimumActiveValidators: 7,
  minimumIndependentOperators: 7,
  minimumInfrastructureDomains: 4,
  minimumRegions: 4,
  maximumSingleOperatorPower: 15,
  maximumSharedFailureDomainPower: 30,
  tolerateAnyTwoValidatorOutages: true,
  requiredOwnerIssues: [100, 106, 117, 119, 123, 124, 126],
});

const mainnet = stage("mainnet-undefined");
assert.equal(mainnet.activation, "reserved-public-inactive");
assert.equal(mainnet.validatorCount, 0);
assert.equal(mainnet.totalVotingPower, 0);
assert.deepEqual(mainnet.votingPower, []);
assert.ok(mainnet.requiredOwnerIssues.includes(104));
assert.ok(mainnet.requiredOwnerIssues.includes(126));

const trustExtension = supportMatrix.extensions.find(
  (extension) => extension.issue === 88
);
assert.ok(trustExtension, "support matrix must record the #88 trust extension");
assert.match(trustExtension.evidence, /fault-test IDs/u);
assert.ok(supportMatrix.downstreamContracts.includes(88));

assert.deepEqual(trust.validatorLifecycle.bootstrap, {
  localnet: "four deterministic genesis validators with equal voting power",
  allocationOwnerIssue: 91,
  privateDevnet:
    "four authority validators on separate hosts before activation",
  publicTestnet:
    "minimum seven independently operated validators after every readiness gate passes",
});
assert.equal(
  trust.validatorLifecycle.admission.mechanism,
  "x/staking MsgCreateValidator plus self-delegation and bonded-set ranking"
);
assert.equal(
  trust.validatorLifecycle.admission.offChainAllowlistAllowed,
  false
);
assert.equal(
  trust.validatorLifecycle.admission.silentGenesisFileMutationAllowed,
  false
);
assert.equal(trust.validatorLifecycle.removal.offChainDeletionAllowed, false);
assert.equal(trust.validatorLifecycle.removal.fundSeizureAllowed, false);
assert.deepEqual(
  trust.validatorLifecycle.states.map(({ id }) => id),
  [
    "candidate",
    "bonded",
    "unbonding",
    "unbonded",
    "jailed-downtime",
    "tombstoned",
  ]
);
assert.equal(
  trust.validatorLifecycle.evidence.maxEvidenceAgeMustNotExceedUnbondingPeriod,
  true
);
assert.equal(
  trust.validatorLifecycle.evidence
    .lightClientTrustingPeriodMustBeLessThanUnbondingPeriod,
  true
);
assert.equal(
  trust.validatorLifecycle.evidence.automaticForkRepairPromised,
  false
);
assert.deepEqual(trust.validatorLifecycle.localRatification, {
  issue: 100,
  protocolVersion: protocol.protocolVersion,
  publicActivationAllowed: false,
  publicActivationGateIssue: 127,
});

const expectedParameters = [
  "staking.max_validators",
  "staking.minimum_validator_stake",
  "staking.max_entries",
  "staking.historical_entries",
  "staking.unbonding_time",
  "staking.min_commission_rate",
  "validator.maximum_commission_rate",
  "validator.maximum_commission_change_rate",
  "distribution.community_tax",
  "distribution.reward_source",
  "slashing.signed_blocks_window",
  "slashing.min_signed_per_window",
  "slashing.downtime_jail_duration",
  "slashing.slash_fraction_downtime",
  "slashing.slash_fraction_double_sign",
  "evidence.max_age_num_blocks",
  "evidence.max_age_duration",
  "evidence.max_bytes",
  "light_client.trusting_period",
  "governance.validator_parameter_authority",
];
assert.deepEqual(
  trust.validatorLifecycle.parameterOwners.map(({ parameter }) => parameter),
  expectedParameters
);
const ratifiedValues = new Map([
  [
    "staking.max_validators",
    String(protocol.validatorEconomics.staking.maximumActiveValidators),
  ],
  [
    "staking.minimum_validator_stake",
    `${protocol.validatorEconomics.staking.minimumSelfDelegationBaseUnits}atorium-self-delegation`,
  ],
  [
    "staking.max_entries",
    String(protocol.validatorEconomics.staking.maximumEntries),
  ],
  [
    "staking.historical_entries",
    String(protocol.validatorEconomics.staking.historicalEntries),
  ],
  [
    "staking.unbonding_time",
    `${protocol.validatorEconomics.staking.unbondingTimeSeconds}s`,
  ],
  ["staking.min_commission_rate", protocol.validatorEconomics.commission.minimumRate],
  [
    "validator.maximum_commission_rate",
    protocol.validatorEconomics.commission.maximumRate,
  ],
  [
    "validator.maximum_commission_change_rate",
    `${protocol.validatorEconomics.commission.maximumDailyChangeRate}-per-24h`,
  ],
  [
    "distribution.community_tax",
    protocol.validatorEconomics.distribution.communityTax,
  ],
  ["distribution.reward_source", "transaction-fees-and-existing-bank-balances-only"],
  [
    "slashing.signed_blocks_window",
    String(protocol.validatorEconomics.slashing.signedBlocksWindow),
  ],
  [
    "slashing.min_signed_per_window",
    protocol.validatorEconomics.slashing.minimumSignedPerWindow,
  ],
  [
    "slashing.downtime_jail_duration",
    `${protocol.validatorEconomics.slashing.downtimeJailDurationSeconds}s`,
  ],
  [
    "slashing.slash_fraction_downtime",
    protocol.validatorEconomics.slashing.downtimeSlashFraction,
  ],
  [
    "slashing.slash_fraction_double_sign",
    `${protocol.validatorEconomics.slashing.doubleSignSlashFraction}-and-permanent-tombstone`,
  ],
  [
    "evidence.max_age_num_blocks",
    String(protocol.validatorEconomics.evidence.maximumAgeBlocks),
  ],
  [
    "evidence.max_age_duration",
    `${protocol.validatorEconomics.evidence.maximumAgeDurationSeconds}s`,
  ],
  [
    "evidence.max_bytes",
    String(protocol.validatorEconomics.evidence.maximumBytesPerBlock),
  ],
  [
    "governance.validator_parameter_authority",
    "cosmos-gov-module-account-via-passed-proposal",
  ],
]);
for (const parameter of trust.validatorLifecycle.parameterOwners) {
  assert.ok(parameter.ownerIssues.length > 0);
  assert.ok(parameter.ownerIssues.every(Number.isInteger));
  assert.ok(parameter.rationale.length > 20);
  const expectedValue = ratifiedValues.get(parameter.parameter);
  if (expectedValue === undefined) {
    assert.equal(parameter.status, "unratified");
    assert.equal(parameter.localValue, undefined);
  } else {
    assert.equal(parameter.status, "ratified-local-only");
    assert.equal(parameter.localValue, expectedValue);
    assert.ok(
      parameter.ownerIssues.includes(
        parameter.parameter === "governance.validator_parameter_authority"
          ? 106
          : 100
      )
    );
  }
}
assert.deepEqual(
  trust.validatorLifecycle.parameterOwners.find(
    ({ parameter }) => parameter === "governance.validator_parameter_authority"
  ).ownerIssues,
  [106]
);

assert.equal(
  trust.finalityContract.commitMeaning,
  "strictly-more-than-two-thirds precommit voting power for a block under the current validator set"
);
assert.equal(
  trust.finalityContract.sdkDefaultConfirmationBlocks,
  protocol.consensus.finality.sdkDefaultConfirmationBlocks
);
assert.equal(
  trust.finalityContract.jsonRpcFinalizedTag,
  protocol.consensus.finality.jsonRpcFinalizedTag
);
assert.equal(
  trust.finalityContract.jsonRpcSafeStateQueries,
  protocol.consensus.finality.jsonRpcSafeStateQueries
);
assert.equal(trust.finalityContract.explorerLabel, "CometBFT committed");
assert.equal(
  trust.finalityContract.ethereumBeaconFinalityClaimAllowed,
  protocol.consensus.finality.ethereumBeaconFinalityEquivalent
);
assert.equal(
  trust.finalityContract.probabilisticConfirmationClaimAllowed,
  false
);
assert.equal(
  trust.finalityContract.boundedTransactionInclusionClaimAllowed,
  false
);
assert.equal(
  trust.finalityContract.sameHeightConflictingCommitExpectedUnderAssumptions,
  false
);
assert.ok(trust.finalityContract.clientTrustRequirements.length >= 4);

assert.equal(
  new Set(trust.faultScenarios.map(({ id }) => id)).size,
  trust.faultScenarios.length
);
assert.equal(
  new Set(trust.faultScenarios.map(({ testId }) => testId)).size,
  trust.faultScenarios.length
);
for (const fault of trust.faultScenarios) {
  assert.match(fault.testId, /^chaos\.[a-z0-9.-]+$/u);
  assert.equal(fault.stage, "localnet-authority");
  assert.ok(fault.availablePower >= 0 && fault.availablePower <= 100);
  assert.ok(fault.byzantinePower >= 0 && fault.byzantinePower <= 100);
  assert.ok(fault.ownerIssues.includes(119));
  assert.ok(fault.expectedLiveness.length > 10);
  assert.ok(fault.expectedSafety.length > 10);
}

assert.deepEqual(scenario("local-one-validator-offline"), {
  id: "local-one-validator-offline",
  testId: "chaos.consensus.local.one-validator-offline",
  stage: "localnet-authority",
  fault: "one 25-power validator is stopped",
  availablePower: 75,
  byzantinePower: 0,
  expectedLiveness:
    "continues-after-round-delay-if-the-offline-node-was-proposer",
  expectedSafety: "no-conflicting-committed-block",
  ownerIssues: [100, 119],
});
assert.equal(scenario("local-two-validators-offline").availablePower, 50);
assert.equal(
  scenario("local-two-validators-offline").expectedLiveness,
  "halts-without-commit-quorum"
);
assert.equal(
  scenario("local-three-one-partition").expectedLiveness,
  "75-power-side-continues-and-25-power-side-cannot-commit"
);
assert.equal(
  scenario("local-two-two-partition").expectedLiveness,
  "both-sides-halt"
);
assert.ok(
  scenario("local-single-equivocation").byzantinePower * 3 <
    localnet.totalVotingPower
);
assert.ok(
  scenario("local-unsafe-byzantine-threshold").byzantinePower * 3 >=
    localnet.totalVotingPower
);
assert.match(
  scenario("local-unsafe-byzantine-threshold").expectedSafety,
  /not-guaranteed/u
);
assert.equal(
  scenario("local-rpc-explorer-outage").expectedLiveness,
  "consensus-continues"
);
assert.match(
  scenario("local-proposer-censorship").expectedLiveness,
  /no-bounded-transaction-inclusion/u
);

assert.ok(trust.publicMessaging.allowedCurrentClaims.length >= 3);
assert.deepEqual(trust.publicMessaging.forbiddenUntilEvidenceAndLaunch, [
  "Torium is decentralized",
  "Torium is trustless",
  "Torium history is immutable",
  "Torium has Ethereum or beacon-chain finality",
  "Torium is censorship resistant",
  "Torium public testnet or mainnet is live",
  "Torium has seven independent validators",
]);
assert.match(
  trust.publicMessaging.requiredQualifier,
  /local, valueless, authority-operated/u
);

assert.deepEqual(
  {
    consensus: trust.proofOfParticipation.consensusInfluence,
    admission: trust.proofOfParticipation.validatorAdmissionInfluence,
    power: trust.proofOfParticipation.votingPowerInfluence,
  },
  { consensus: "none", admission: "none", power: "none" }
);
assert.equal(trust.proofOfParticipation.status, "explicitly-deferred");
assert.ok(
  trust.proofOfParticipation.requirementsBeforeChange.includes(
    "independent security audit"
  )
);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      modelVersion: trust.modelVersion,
      consensus: `${trust.protocol.consensusEngine} ${trust.protocol.consensusVersion}`,
      stages: trust.stages.map(({ id, activation }) => ({ id, activation })),
      localnet: {
        validators: localnet.validatorCount,
        totalPower: localnet.totalVotingPower,
        commitQuorum: localnet.commitQuorumPower,
      },
      publicTestnetReadiness: {
        active: false,
        minimumIndependentOperators:
          publicReadiness.readinessGates.minimumIndependentOperators,
        toleratesAnyTwoOutages:
          publicReadiness.readinessGates.tolerateAnyTwoValidatorOutages,
      },
      faultScenarios: trust.faultScenarios.length,
      ratifiedLocalLifecycleParameters: ratifiedValues.size,
      unratifiedLifecycleParameters: trust.validatorLifecycle.parameterOwners.filter(
        ({ status }) => status === "unratified"
      ).length,
      unratifiedLivenessParameters: trust.livenessParameterOwners.length,
      proofOfParticipationInfluence: "none",
    },
    null,
    2
  )}\n`
);
