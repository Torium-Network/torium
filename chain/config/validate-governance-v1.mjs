#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, "../..");
const [contract, protocol, fixture, genesis, appSource, privilegedServicesSource, upgradesSource] = await Promise.all([
  readFile(join(directory, "governance-v1.json"), "utf8").then(JSON.parse),
  readFile(join(directory, "protocol-v1.json"), "utf8").then(JSON.parse),
  readFile(join(root, "chain/app/localnet/fixture.json"), "utf8").then(JSON.parse),
  readFile(join(root, "chain/genesis/localnet/genesis.json"), "utf8").then(JSON.parse),
  readFile(join(root, "chain/app/app.go"), "utf8"),
  readFile(join(root, "chain/app/privileged_services.go"), "utf8"),
  readFile(join(root, "chain/app/upgrades.go"), "utf8"),
]);

assert.equal(contract.$schema, "./governance-v1.schema.json");
assert.equal(contract.schemaVersion, 1);
assert.match(contract.contractVersion, /^1\.0\.0-local\.[1-9][0-9]*$/u);
assert.equal(contract.status, "ratified-local-only");
assert.equal(contract.protocol.path, "./protocol-v1.json");
assert.equal(contract.protocol.version, protocol.protocolVersion);
assert.deepEqual(contract.scope, {
  environment: "localnet",
  valueStatus: "valueless",
  publicActivationAllowed: false,
  publicActivationGateIssue: 127,
  toriumProductBackendIntegrated: false,
});

const governance = contract.governance;
assert.equal(governance.authority, "cosmos-gov-module-account");
assert.equal(governance.proposalSubmission, "permissionless-funded-transaction");
assert.equal(
  governance.proposalExecution,
  "passed-proposal-routed-as-governance-module-account"
);
assert.deepEqual(governance.consensusAuthority, {
  genesisValue: "cosmos-gov-module-account",
  mutable: false,
  transferRejectedByApplication: true,
});
assert.equal(governance.maxDepositPeriodSeconds, 30);
assert.equal(governance.votingPeriodSeconds, 20);
assert.equal(governance.expeditedVotingPeriodSeconds, 10);
assert.ok(
  governance.expeditedVotingPeriodSeconds < governance.votingPeriodSeconds,
  "expedited voting must be shorter"
);
assert.deepEqual(governance.minDeposit, {
  denom: protocol.nativeAsset.baseDenom,
  amountBaseUnits: "10000000000000000000",
});
assert.deepEqual(governance.expeditedMinDeposit, {
  denom: protocol.nativeAsset.baseDenom,
  amountBaseUnits: "50000000000000000000",
});
assert.ok(
  BigInt(governance.expeditedMinDeposit.amountBaseUnits) >
    BigInt(governance.minDeposit.amountBaseUnits)
);
assert.deepEqual(
  {
    quorum: governance.quorum,
    threshold: governance.threshold,
    expeditedThreshold: governance.expeditedThreshold,
    vetoThreshold: governance.vetoThreshold,
    minInitialDepositRatio: governance.minInitialDepositRatio,
    minimumDepositRatio: governance.minimumDepositRatio,
    proposalCancelRatio: governance.proposalCancelRatio,
  },
  {
    quorum: "0.667000000000000000",
    threshold: "0.500000000000000000",
    expeditedThreshold: "0.667000000000000000",
    vetoThreshold: "0.334000000000000000",
    minInitialDepositRatio: "1.000000000000000000",
    minimumDepositRatio: "1.000000000000000000",
    proposalCancelRatio: "0.500000000000000000",
  }
);
assert.deepEqual(governance.fourEqualValidators, {
  totalVotingPower: 100,
  votesRequiredForQuorum: 3,
  twoValidatorVoteReachesQuorum: false,
  threeValidatorYesVotePasses: true,
});
assert.equal(governance.proposalCancelDestination, "burn");
assert.equal(governance.burnDepositOnPrevoteFailure, true);
assert.equal(governance.burnDepositOnQuorumFailure, true);
assert.equal(governance.burnDepositOnVeto, true);

const validatorPower = fixture.accounts
  .filter((account) => account.role === "validator")
  .map((account) => account.expected_voting_power);
assert.deepEqual(validatorPower, [25, 25, 25, 25]);
assert.equal(validatorPower.reduce((sum, power) => sum + power, 0), 100);

const genesisParams = genesis.app_state.gov.params;
assert.equal(genesisParams.max_deposit_period, "30s");
assert.equal(genesisParams.voting_period, "20s");
assert.equal(genesisParams.expedited_voting_period, "10s");
assert.deepEqual(genesisParams.min_deposit, [
  {
    denom: governance.minDeposit.denom,
    amount: governance.minDeposit.amountBaseUnits,
  },
]);
assert.deepEqual(genesisParams.expedited_min_deposit, [
  {
    denom: governance.expeditedMinDeposit.denom,
    amount: governance.expeditedMinDeposit.amountBaseUnits,
  },
]);
for (const [genesisField, contractField] of [
  ["quorum", "quorum"],
  ["threshold", "threshold"],
  ["expedited_threshold", "expeditedThreshold"],
  ["veto_threshold", "vetoThreshold"],
  ["min_initial_deposit_ratio", "minInitialDepositRatio"],
  ["min_deposit_ratio", "minimumDepositRatio"],
  ["proposal_cancel_ratio", "proposalCancelRatio"],
]) {
  assert.equal(genesisParams[genesisField], governance[contractField]);
}
assert.equal(genesisParams.proposal_cancel_dest, "");
assert.equal(genesisParams.burn_proposal_deposit_prevote, true);
assert.equal(genesisParams.burn_vote_quorum, true);
assert.equal(genesisParams.burn_vote_veto, true);
const governanceModuleAddress = "torium10d07y265gmmuvt4z0w9aw880jnsr700jjk4usp";
assert.equal(genesis.consensus.params.authority.authority, governanceModuleAddress);

const expectedModules = [
  "auth", "bank", "consensus", "distribution", "staking", "slashing",
  "upgrade", "evm", "erc20", "feemarket",
];
assert.deepEqual(
  contract.authorities.map(({ module }) => module),
  expectedModules
);
assert.equal(new Set(contract.authorities.map(({ module }) => module)).size, 10);
for (const authority of contract.authorities) {
  assert.equal(authority.authority, "cosmos-gov-module-account");
  assert.ok(authority.surface.length > 0);
}
assert.deepEqual(contract.contractAuthorities, {
  mutableSystemContractsDeployed: false,
  nativeFacade: {
    address: protocol.nativeAsset.solidityInterface.address,
    kind: "bank-backed-native-precompile",
    adminAuthority: "none",
    upgradeAuthority: "none-static-runtime-composition",
  },
  governancePrecompile: {
    address: protocol.evm.activeCustomPrecompiles.find(({ name }) => name === "governance").address,
    stateMutationAuthority: "underlying-module-message-authorization",
    privilegedBypassAllowed: false,
  },
  futureSystemContractRegistry: {
    status: "not-implemented",
    ownerIssue: 108,
  },
});
assert.match(appSource, /authAddr := authtypes\.NewModuleAddress\(govtypes\.ModuleName\)\.String\(\)/u);
const authorityWiring = {
  auth: /authkeeper\.NewAccountKeeper\([\s\S]*?authAddr,\s*\)/u,
  bank: /bankkeeper\.NewBaseKeeper\([\s\S]*?authAddr,\s*logger,\s*\)/u,
  consensus: /consensusparamkeeper\.NewKeeper\([\s\S]*?authAddr,[\s\S]*?\)/u,
  distribution: /distrkeeper\.NewKeeper\([\s\S]*?authtypes\.FeeCollectorName,\s*authAddr,\s*\)/u,
  staking: /stakingkeeper\.NewKeeper\([\s\S]*?app\.BankKeeper,\s*authAddr,/u,
  slashing: /slashingkeeper\.NewKeeper\([\s\S]*?app\.StakingKeeper,\s*authAddr,\s*\)/u,
  upgrade: /upgradekeeper\.NewKeeper\([\s\S]*?app\.BaseApp,\s*authAddr,\s*\)/u,
  evm: /evmkeeper\.NewKeeper\([\s\S]*?authtypes\.NewModuleAddress\(govtypes\.ModuleName\),/u,
  erc20: /erc20keeper\.NewKeeper\([\s\S]*?authtypes\.NewModuleAddress\(govtypes\.ModuleName\),/u,
  feemarket: /feemarketkeeper\.NewKeeper\(\s*appCodec,\s*authtypes\.NewModuleAddress\(govtypes\.ModuleName\),/u,
};
for (const authority of contract.authorities) {
  assert.match(appSource, authorityWiring[authority.module], `${authority.module} authority wiring drifted`);
}
assert.match(appSource, /govkeeper\.NewKeeper\([\s\S]*?govConfig,\s*authAddr,/u);
assert.match(appSource, /newToriumConsensusAppModule\([\s\S]*?authAddr\)/u);
assert.match(appSource, /newToriumUpgradeAppModule\([\s\S]*?authAddr\)/u);
assert.match(
  privilegedServicesSource,
  /message\.Auth != nil && message\.Auth\.Authority != server\.authority/u,
  "consensus AuthorityParams transfer guard drifted"
);
assert.match(
  privilegedServicesSource,
  /minimumHeight := currentHeight \+ server\.minimumLeadBlocks/u,
  "upgrade minimum scheduling lead guard drifted"
);

assert.deepEqual(contract.authorizationRules, {
  directPrivilegedTransactionAllowed: false,
  undocumentedAdminKeyAllowed: false,
  offChainProposalExecutionAllowed: false,
  normalUpgradeRequiresPassedPlan: true,
  normalOperatorProcedureRequiresChecksumPreflight: true,
  onChainExecutableChecksumEnforced: false,
  failedUncommittedMigrationFixForwardMayUseNewReviewedChecksum: true,
  governancePrecompileMayBypassModuleAuthority: false,
  parameterChangesRequirePassedProposal: true,
  upgradeSchedulingAndCancellationRequirePassedProposal: true,
});
assert.equal(contract.bootstrapAndTransition.decentralizationClaimAllowed, false);
assert.equal(contract.bootstrapAndTransition.futurePublicAuthority, "not-selected");
assert.deepEqual(contract.bootstrapAndTransition.requiredBeforePublicActivation, [
  "independent-validator-operators-and-key-custody",
  "public-governance-economics-review",
  "multisig-or-validator-authority-transition-decision",
  "security-review-and-upgrade-rehearsal",
  "fresh-genesis-and-release-artifact-approval",
]);

const upgrade = contract.upgrade;
assert.equal(upgrade.planName, "torium-local-v1");
assert.equal(upgrade.preUpgradeVersion, "0.1.0-local.1");
assert.equal(upgrade.postUpgradeVersion, "0.2.0-local.1");
assert.ok(upgrade.minimumSchedulingLeadBlocks >= 10);
assert.equal(upgrade.minimumSchedulingLeadEnforcedAtProposalExecution, true);
assert.deepEqual(upgrade.planInfoRequires, [
  "schemaVersion", "planName", "targetVersion", "binarySha256",
  "protocolVersion", "migrationSha256",
]);
assert.deepEqual(upgrade.binaryProfiles, {
  pre: "no-handler-halts-and-writes-upgrade-info-at-plan-height",
  post: "named-handler-rejects-start-before-plan-height-and-applies-at-plan-height",
  failedRehearsal: "named-handler-returns-deterministic-error-without-committing-migration-state",
});
assert.deepEqual(upgrade.migration, {
  runModuleMigrations: true,
  markerStoreAddedAtUpgrade: true,
  writeDeterministicMarker: true,
  markerStore: "toriumupgrade",
  markerSchemaVersion: 1,
  preserveNativeSupply: true,
  preserveAccountsBalancesContractsAndStaking: true,
});
assert.deepEqual(upgrade.artifactVerification, {
  checksumAlgorithm: "sha256",
  checksumVerifiedByHandler: false,
  checksumVerifiedByOperatorPreflight: true,
  checksumEnforcementScope: "operator-procedure-not-consensus",
  versionVerifiedByHandler: true,
  protocolVersionVerifiedByHandler: true,
  migrationChecksumVerifiedByHandler: true,
});
assert.deepEqual(upgrade.storeLoader, {
  source: "data/upgrade-info.json-written-by-pre-upgrade-binary",
  onlyAtNextHeight: true,
  unknownPlanRejected: true,
  addedStoreKeys: ["toriumupgrade"],
});
assert.match(
  upgradesSource,
  /Added:\s*\[\]string\{toriumUpgradeStoreKey\}/u,
  "upgrade store loader no longer adds the marker store"
);

const expectedScenarios = [
  "unauthorized-direct-privileged-message",
  "consensus-authority-transfer-rejected",
  "short-lead-upgrade-plan-failed",
  "premature-post-upgrade-binary",
  "old-binary-at-plan-height",
  "wrong-binary-checksum",
  "two-validator-no-quorum",
  "partial-three-validator-upgrade",
  "late-validator-catch-up",
  "failed-migration-no-commit",
];
assert.deepEqual(contract.failureAndRecovery.rehearsedScenarios, expectedScenarios);
assert.deepEqual(
  { ...contract.failureAndRecovery, rehearsedScenarios: undefined },
  {
    rehearsedScenarios: undefined,
    preHeightCancellation: "new-passed-governance-proposal-only",
    skipUpgradeHeightAllowedInStandardProfile: false,
    rollbackAfterCommittedUpgradeAllowed: false,
    failedMigrationRemediation: "fix-forward-new-checksummed-binary-at-same-uncommitted-height",
    localFixtureFallback: "restore-all-nodes-from-verified-pre-upgrade-recovery-or-reset-valueless-localnet",
    publicRollbackPolicy: "not-defined-public-launch-blocked",
  }
);
assert.equal(contract.evidence.suite, "chain/tests/governance-upgrade");
assert.equal(contract.evidence.postUpgradeRecoveryFixture, "post-upgrade");
assert.deepEqual(contract.evidence.requiredBeforeAndAfter, [
  "height-and-app-hash",
  "native-total-supply",
  "sample-account-balance",
  "staking-validator-set",
  "module-version-map",
  "migration-marker",
  "binary-version-and-sha256",
]);

console.log(
  `governance ${contract.contractVersion}: ${contract.authorities.length} authorities, ` +
    `${expectedScenarios.length} failure/recovery scenarios, public activation blocked`
);
