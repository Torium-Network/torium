import {
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isHex,
  keccak256,
  toBytes,
  zeroHash,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import {
  ToriumSdkError,
  type ToriumReadActionOptions,
  type ToriumSdkErrorCategory,
} from "./errors.js";
import { runToriumReadAction } from "./internal/execution.js";
import { assertToriumUint256 } from "./utils.js";
import type { ToriumTransactionRequest } from "./wallet.js";
import {
  toriumAttestationRegistryAbi,
  toriumCreate2FactoryAbi,
  toriumNativeAbi,
  toriumRewardDistributorAbi,
} from "./generated/contracts/abis.js";
import { toriumLocalnetContractRegistry } from "./generated/contracts/deployments.js";

export {
  toriumAttestationRegistryAbi,
  toriumCreate2FactoryAbi,
  toriumNativeAbi,
  toriumRewardDistributorAbi,
} from "./generated/contracts/abis.js";
export {
  toriumLocalnetContractRegistry,
  type ToriumLocalnetContractRegistry,
} from "./generated/contracts/deployments.js";

export const toriumContractNames = [
  "toriumNative",
  "toriumCreate2Factory",
  "toriumRewardDistributor",
  "toriumAttestationRegistry",
] as const;

export type ToriumContractName = (typeof toriumContractNames)[number];

export const toriumContractAbis = Object.freeze({
  toriumNative: toriumNativeAbi,
  toriumCreate2Factory: toriumCreate2FactoryAbi,
  toriumRewardDistributor: toriumRewardDistributorAbi,
  toriumAttestationRegistry: toriumAttestationRegistryAbi,
} as const) satisfies Readonly<Record<ToriumContractName, Abi>>;

/** EVM chain served by the generated default deployment registry. */
export const toriumContractRegistryChainId =
  toriumLocalnetContractRegistry.chain.evmChainId;

export type ToriumContractErrorCode =
  | "TORIUM_CONTRACT_CONFIG_INVALID"
  | "TORIUM_CONTRACT_NOT_DEPLOYED"
  | "TORIUM_CONTRACT_CODE_MISSING"
  | "TORIUM_CONTRACT_CODE_MISMATCH"
  | "TORIUM_CONTRACT_VERSION_MISMATCH"
  | "TORIUM_CONTRACT_RESPONSE_INVALID"
  | "TORIUM_CONTRACT_REVERTED";

const contractErrorCategories: Readonly<
  Record<ToriumContractErrorCode, ToriumSdkErrorCategory>
> = Object.freeze({
  TORIUM_CONTRACT_CONFIG_INVALID: "configuration",
  TORIUM_CONTRACT_NOT_DEPLOYED: "contract",
  TORIUM_CONTRACT_CODE_MISSING: "contract",
  TORIUM_CONTRACT_CODE_MISMATCH: "contract",
  TORIUM_CONTRACT_VERSION_MISMATCH: "compatibility",
  TORIUM_CONTRACT_RESPONSE_INVALID: "rpc",
  TORIUM_CONTRACT_REVERTED: "revert",
});

export class ToriumContractError extends ToriumSdkError<ToriumContractErrorCode> {
  readonly contractName?: ToriumContractName;
  readonly address?: Address;
  readonly errorName?: string;
  readonly errorArgs?: readonly unknown[];

  constructor(
    code: ToriumContractErrorCode,
    message: string,
    options: {
      readonly contractName?: ToriumContractName;
      readonly address?: Address;
      readonly errorName?: string;
      readonly errorArgs?: readonly unknown[];
      readonly cause?: unknown;
      readonly operation?: string;
      readonly method?: string;
      readonly chainId?: number;
      readonly requestId?: string;
      readonly revertData?: Hex;
      readonly revertReason?: string;
      readonly issues?: readonly string[];
    } = {}
  ) {
    super({
      code,
      category: contractErrorCategories[code],
      message,
      cause: options.cause,
      operation: options.operation,
      kind: "read",
      clientKind: "contract",
      method: options.method,
      chainId: options.chainId,
      requestId: options.requestId,
      retryable: false,
      safeToRetry: false,
      revertData: options.revertData,
      revertReason: options.revertReason,
      issues: options.issues,
    });
    this.name = "ToriumContractError";
    this.contractName = options.contractName;
    this.address = options.address;
    this.errorName = options.errorName;
    this.errorArgs = options.errorArgs;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.contractName === undefined
        ? {}
        : { contractName: this.contractName }),
      ...(this.address === undefined ? {} : { address: this.address }),
      ...(this.errorName === undefined ? {} : { errorName: this.errorName }),
    };
  }
}

export interface ToriumContractDeployment {
  readonly contractName: ToriumContractName;
  readonly address: Address;
  readonly abi: Abi;
  readonly implementationVersion: string;
  readonly runtimeCodeKeccak256: Hash | null;
}

export interface ToriumContractDeploymentOverride {
  readonly address: Address;
  readonly implementationVersion?: string;
  readonly runtimeCodeKeccak256?: Hash;
}

interface RegistryCatalogEntry {
  readonly address: Address | null;
  readonly implementationVersion: string;
  readonly runtimeCodeKeccak256: Hash | null;
  readonly status: string;
}

const registryContracts = toriumLocalnetContractRegistry.contracts;

const registryCatalog: Readonly<
  Record<ToriumContractName, RegistryCatalogEntry>
> = Object.freeze({
  toriumNative: Object.freeze({
    address: registryContracts.toriumNative.address,
    implementationVersion: registryContracts.toriumNative.implementationVersion,
    runtimeCodeKeccak256: null,
    status: registryContracts.toriumNative.status,
  }),
  toriumCreate2Factory: Object.freeze({
    address: registryContracts.toriumCreate2Factory.address,
    implementationVersion:
      registryContracts.toriumCreate2Factory.implementationVersion,
    runtimeCodeKeccak256:
      registryContracts.toriumCreate2Factory.runtimeCodeKeccak256,
    status: registryContracts.toriumCreate2Factory.status,
  }),
  toriumRewardDistributor: Object.freeze({
    address: registryContracts.toriumRewardDistributor.address,
    implementationVersion:
      registryContracts.toriumRewardDistributor.implementationVersion,
    runtimeCodeKeccak256:
      registryContracts.toriumRewardDistributor.runtimeCodeKeccak256,
    status: registryContracts.toriumRewardDistributor.status,
  }),
  toriumAttestationRegistry: Object.freeze({
    address: registryContracts.toriumAttestationRegistry.address,
    implementationVersion:
      registryContracts.toriumAttestationRegistry.implementationVersion,
    runtimeCodeKeccak256:
      registryContracts.toriumAttestationRegistry.runtimeCodeKeccak256,
    status: registryContracts.toriumAttestationRegistry.status,
  }),
});

export interface ResolveToriumContractDeploymentOptions {
  readonly deployment?: ToriumContractDeploymentOverride;
  readonly expectedImplementationVersion?: string;
}

/**
 * Resolves a contract deployment from the generated localnet registry, or from
 * an explicit local deployment override. Registry entries without a broadcast
 * address fail closed instead of inventing one.
 */
export function resolveToriumContractDeployment(
  contractName: ToriumContractName,
  options: ResolveToriumContractDeploymentOptions = {}
): ToriumContractDeployment {
  const abi = toriumContractAbis[contractName];
  const registryEntry = registryCatalog[contractName];
  const override = options.deployment;

  let deployment: ToriumContractDeployment;
  if (override === undefined) {
    if (registryEntry.address === null) {
      throw new ToriumContractError(
        "TORIUM_CONTRACT_NOT_DEPLOYED",
        `The generated registry has no broadcast ${contractName} address (status: ${registryEntry.status}); pass an explicit local deployment.`,
        { contractName, operation: "resolveToriumContractDeployment" }
      );
    }
    deployment = {
      contractName,
      address: normalizeContractAddress(contractName, registryEntry.address),
      abi,
      implementationVersion: registryEntry.implementationVersion,
      runtimeCodeKeccak256: registryEntry.runtimeCodeKeccak256,
    };
  } else {
    const overrideVersion =
      override.implementationVersion ?? registryEntry.implementationVersion;
    deployment = {
      contractName,
      address: normalizeContractAddress(contractName, override.address),
      abi,
      implementationVersion: overrideVersion,
      runtimeCodeKeccak256:
        override.runtimeCodeKeccak256 ??
        (overrideVersion === registryEntry.implementationVersion
          ? registryEntry.runtimeCodeKeccak256
          : null),
    };
  }

  if (
    options.expectedImplementationVersion !== undefined &&
    options.expectedImplementationVersion !== deployment.implementationVersion
  ) {
    throw new ToriumContractError(
      "TORIUM_CONTRACT_VERSION_MISMATCH",
      `The resolved ${contractName} implementation version ${deployment.implementationVersion} does not match the expected version ${options.expectedImplementationVersion}.`,
      {
        contractName,
        address: deployment.address,
        operation: "resolveToriumContractDeployment",
      }
    );
  }
  return Object.freeze(deployment);
}

export interface ToriumContractCodeClient {
  getCode(parameters: { readonly address: Address }): Promise<Hex | undefined>;
}

export interface ToriumContractCodeVerification {
  readonly contractName: ToriumContractName;
  readonly address: Address;
  readonly implementationVersion: string;
  readonly runtimeCodeKeccak256: Hash;
}

/**
 * Confirms that the deployed runtime bytecode matches the deployment's pinned
 * keccak-256 hash, so a wrong address or drifted implementation fails closed.
 */
export async function verifyToriumContractDeployment(
  client: ToriumContractCodeClient,
  deployment: ToriumContractDeployment,
  options: ToriumReadActionOptions = {}
): Promise<ToriumContractCodeVerification> {
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const expected = deployment.runtimeCodeKeccak256;
      if (expected === null) {
        throw new ToriumContractError(
          "TORIUM_CONTRACT_CONFIG_INVALID",
          `The ${deployment.contractName} deployment has no pinned runtime code hash to verify against.`,
          {
            contractName: deployment.contractName,
            address: deployment.address,
            operation: "verifyToriumContractDeployment",
          }
        );
      }
      const code = await client.getCode({ address: deployment.address });
      signal.throwIfAborted();
      if (code === undefined || code === "0x") {
        throw new ToriumContractError(
          "TORIUM_CONTRACT_CODE_MISSING",
          `No runtime bytecode exists at the ${deployment.contractName} address ${deployment.address}.`,
          {
            contractName: deployment.contractName,
            address: deployment.address,
            operation: "verifyToriumContractDeployment",
          }
        );
      }
      if (!isHex(code)) {
        throw invalidContractResponse(
          deployment.contractName,
          "eth_getCode",
          "verifyToriumContractDeployment"
        );
      }
      const actual = keccak256(code);
      if (actual !== expected.toLowerCase()) {
        throw new ToriumContractError(
          "TORIUM_CONTRACT_CODE_MISMATCH",
          `The runtime bytecode at ${deployment.address} does not match the pinned ${deployment.contractName} ${deployment.implementationVersion} hash.`,
          {
            contractName: deployment.contractName,
            address: deployment.address,
            operation: "verifyToriumContractDeployment",
            issues: [`expected ${expected}`, `actual ${actual}`],
          }
        );
      }
      return Object.freeze({
        contractName: deployment.contractName,
        address: deployment.address,
        implementationVersion: deployment.implementationVersion,
        runtimeCodeKeccak256: actual,
      });
    },
    {
      operation: "verifyToriumContractDeployment",
      clientKind: "contract",
      method: "eth_getCode",
    },
    options
  );
}

export interface DecodedToriumContractRevert {
  readonly contractName: ToriumContractName;
  readonly errorName: string;
  readonly args: readonly unknown[];
}

/** Decodes custom-error revert data against a generated contract ABI. */
export function decodeToriumContractRevert(
  contractName: ToriumContractName,
  revertData: Hex
): DecodedToriumContractRevert | null {
  try {
    const decoded = decodeErrorResult({
      abi: toriumContractAbis[contractName],
      data: revertData,
    });
    return {
      contractName,
      errorName: decoded.errorName,
      args: decoded.args ?? [],
    };
  } catch {
    return null;
  }
}

/** Walks an error cause chain and extracts raw revert data when present. */
export function extractToriumRevertData(error: unknown): Hex | null {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && isObjectLike(current); depth += 1) {
    for (const key of ["raw", "data"] as const) {
      const value = current[key];
      if (typeof value === "string" && isHex(value) && value.length >= 10) {
        return value;
      }
      if (isObjectLike(value)) {
        const nested = value["data"];
        if (
          typeof nested === "string" &&
          isHex(nested) &&
          nested.length >= 10
        ) {
          return nested;
        }
      }
    }
    current = current["cause"];
  }
  return null;
}

export interface ToriumContractCallClient {
  call(parameters: {
    readonly account?: Address;
    readonly to: Address;
    readonly data: Hex;
    readonly value?: bigint;
  }): Promise<unknown>;
}

/**
 * Simulates a prepared contract transaction with `eth_call` and rethrows
 * decoded custom-error reverts as typed contract errors. It never submits.
 */
export async function simulateToriumContractRequest(
  client: ToriumContractCallClient,
  contractName: ToriumContractName,
  request: ToriumTransactionRequest,
  options: ToriumReadActionOptions = {}
): Promise<void> {
  const to = request.to;
  if (to === undefined || to === null) {
    throw new ToriumContractError(
      "TORIUM_CONTRACT_CONFIG_INVALID",
      "Torium contract simulation requires a contract target address.",
      { contractName, operation: "simulateToriumContractRequest" }
    );
  }
  await runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      try {
        await client.call({
          ...(typeof request.account === "string"
            ? { account: request.account }
            : request.account === undefined
              ? {}
              : { account: request.account.address }),
          to,
          data: request.data ?? "0x",
          ...(request.value === undefined ? {} : { value: request.value }),
        });
      } catch (error) {
        const revertData = extractToriumRevertData(error);
        if (revertData !== null) {
          const decoded = decodeToriumContractRevert(contractName, revertData);
          throw new ToriumContractError(
            "TORIUM_CONTRACT_REVERTED",
            decoded === null
              ? `The simulated ${contractName} call reverted with undecodable data.`
              : `The simulated ${contractName} call reverted with ${decoded.errorName}.`,
            {
              contractName,
              address: to,
              operation: "simulateToriumContractRequest",
              method: "eth_call",
              cause: error,
              revertData,
              ...(decoded === null
                ? {}
                : {
                    errorName: decoded.errorName,
                    errorArgs: decoded.args,
                    revertReason: decoded.errorName,
                  }),
            }
          );
        }
        throw error;
      }
    },
    {
      operation: "simulateToriumContractRequest",
      clientKind: "contract",
      method: "eth_call",
      fallbackCategory: "simulation",
    },
    options
  );
}

export interface ToriumContractReadClient {
  readContract(parameters: {
    readonly address: Address;
    readonly abi: Abi;
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
}

// --- Reward distributor -----------------------------------------------------

export const toriumRewardDistributorRoles = Object.freeze({
  epochPublisher: keccak256(toBytes("EPOCH_PUBLISHER_ROLE")),
  pauser: keccak256(toBytes("PAUSER_ROLE")),
  clawback: keccak256(toBytes("CLAWBACK_ROLE")),
} as const);

export interface ToriumRewardProofNode {
  readonly nodeHash: Hash;
  readonly sum: bigint;
}

export interface ToriumRewardClaimLeaf {
  readonly epochId: bigint;
  readonly index: bigint;
  readonly account: Address;
  readonly amount: bigint;
}

export interface ToriumRewardEpoch {
  readonly epochId: bigint;
  readonly rootHash: Hash;
  readonly funded: bigint;
  readonly claimStart: bigint;
  readonly claimEnd: bigint;
  readonly claimed: bigint;
  readonly clawed: bigint;
}

export interface ToriumRewardDistributorState {
  readonly nextEpochId: bigint;
  readonly totalFunded: bigint;
  readonly totalClaimed: bigint;
  readonly totalClawed: bigint;
  readonly treasury: Address;
  readonly publicationDelay: bigint;
  readonly clawbackDelay: bigint;
  readonly paused: boolean;
}

/** Hashes one Merkle-sum leaf exactly as `ToriumRewardDistributor.leafHash`. */
export function hashToriumRewardLeaf(leaf: ToriumRewardClaimLeaf): Hash {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        assertToriumUint256(leaf.epochId),
        assertToriumUint256(leaf.index),
        getAddress(leaf.account),
        assertToriumUint256(leaf.amount),
      ]
    )
  );
}

/** Combines two Merkle-sum nodes exactly as `ToriumRewardDistributor.hashNode`. */
export function hashToriumRewardNode(
  first: ToriumRewardProofNode,
  second: ToriumRewardProofNode
): ToriumRewardProofNode {
  const sum = assertToriumUint256(
    assertToriumUint256(first.sum) + assertToriumUint256(second.sum)
  );
  const [left, right] =
    first.nodeHash.toLowerCase() <= second.nodeHash.toLowerCase()
      ? [first, second]
      : [second, first];
  return {
    nodeHash: keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "uint256" },
        ],
        [left.nodeHash, left.sum, right.nodeHash, right.sum]
      )
    ),
    sum,
  };
}

export interface ToriumRewardProofResult {
  readonly rootHash: Hash;
  readonly rootSum: bigint;
}

/**
 * Reconstructs the Merkle-sum root committed by a claim path, mirroring the
 * on-chain `processProof`, including its malformed-node rejections.
 */
export function processToriumRewardProof(
  leaf: ToriumRewardClaimLeaf,
  proof: readonly ToriumRewardProofNode[]
): ToriumRewardProofResult {
  let node: ToriumRewardProofNode = {
    nodeHash: hashToriumRewardLeaf(leaf),
    sum: assertToriumUint256(leaf.amount),
  };
  for (const [proofIndex, sibling] of proof.entries()) {
    if (sibling.nodeHash === zeroHash || sibling.sum === 0n) {
      throw new RangeError(
        `Torium reward proof node ${proofIndex} is malformed.`
      );
    }
    node = hashToriumRewardNode(node, sibling);
  }
  return { rootHash: node.nodeHash, rootSum: node.sum };
}

export interface ToriumRewardDistributorReadParameters {
  readonly deployment?: ToriumContractDeploymentOverride;
}

export async function getToriumRewardDistributorState(
  client: ToriumContractReadClient,
  parameters: ToriumRewardDistributorReadParameters = {},
  options: ToriumReadActionOptions = {}
): Promise<ToriumRewardDistributorState> {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const [
        nextEpochId,
        totalFunded,
        totalClaimed,
        totalClawed,
        treasury,
        publicationDelay,
        clawbackDelay,
        paused,
      ] = await Promise.all([
        readRewardFunction(client, deployment, "nextEpochId"),
        readRewardFunction(client, deployment, "totalFunded"),
        readRewardFunction(client, deployment, "totalClaimed"),
        readRewardFunction(client, deployment, "totalClawed"),
        readRewardFunction(client, deployment, "treasury"),
        readRewardFunction(client, deployment, "publicationDelay"),
        readRewardFunction(client, deployment, "clawbackDelay"),
        readRewardFunction(client, deployment, "paused"),
      ]);
      signal.throwIfAborted();
      return Object.freeze({
        nextEpochId: parseUint(nextEpochId, deployment, "nextEpochId"),
        totalFunded: parseUint(totalFunded, deployment, "totalFunded"),
        totalClaimed: parseUint(totalClaimed, deployment, "totalClaimed"),
        totalClawed: parseUint(totalClawed, deployment, "totalClawed"),
        treasury: parseAddressValue(treasury, deployment, "treasury"),
        publicationDelay: parseUint(
          publicationDelay,
          deployment,
          "publicationDelay"
        ),
        clawbackDelay: parseUint(clawbackDelay, deployment, "clawbackDelay"),
        paused: parseBooleanValue(paused, deployment, "paused"),
      });
    },
    {
      operation: "getToriumRewardDistributorState",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export interface GetToriumRewardEpochParameters extends ToriumRewardDistributorReadParameters {
  readonly epochId: bigint;
}

export async function getToriumRewardEpoch(
  client: ToriumContractReadClient,
  parameters: GetToriumRewardEpochParameters,
  options: ToriumReadActionOptions = {}
): Promise<ToriumRewardEpoch | null> {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  const epochId = assertToriumUint256(parameters.epochId);
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const raw = await readRewardFunction(client, deployment, "epochs", [
        epochId,
      ]);
      return parseRewardEpoch(raw, deployment, epochId);
    },
    {
      operation: "getToriumRewardEpoch",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export interface IsToriumRewardClaimedParameters extends ToriumRewardDistributorReadParameters {
  readonly epochId: bigint;
  readonly index: bigint;
}

export async function isToriumRewardClaimed(
  client: ToriumContractReadClient,
  parameters: IsToriumRewardClaimedParameters,
  options: ToriumReadActionOptions = {}
): Promise<boolean> {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  const epochId = assertToriumUint256(parameters.epochId);
  const index = assertToriumUint256(parameters.index);
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const raw = await readRewardFunction(client, deployment, "isClaimed", [
        epochId,
        index,
      ]);
      return parseBooleanValue(raw, deployment, "isClaimed");
    },
    {
      operation: "isToriumRewardClaimed",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export type ToriumRewardClaimBlocker =
  | "epoch-not-found"
  | "distributor-paused"
  | "claim-not-started"
  | "claim-window-closed"
  | "already-claimed"
  | "malformed-proof"
  | "invalid-proof";

export interface ToriumRewardClaimPreflight {
  readonly canClaim: boolean;
  readonly blockers: readonly ToriumRewardClaimBlocker[];
  readonly epoch: ToriumRewardEpoch | null;
  readonly currentTimestamp: bigint;
  readonly computedRootHash: Hash | null;
  readonly computedRootSum: bigint | null;
}

export interface ToriumRewardClaimPreflightClient extends ToriumContractReadClient {
  getBlock(parameters: {
    readonly blockTag: "latest";
  }): Promise<{ readonly timestamp: bigint }>;
}

export interface PreflightToriumRewardClaimParameters extends ToriumRewardDistributorReadParameters {
  readonly epochId: bigint;
  readonly index: bigint;
  readonly account: Address;
  readonly amount: bigint;
  readonly proof: readonly ToriumRewardProofNode[];
}

/**
 * Rebuilds the claim's Merkle-sum root locally and checks epoch existence,
 * claim window, pause state, and double-claim bits before any signature.
 */
export async function preflightToriumRewardClaim(
  client: ToriumRewardClaimPreflightClient,
  parameters: PreflightToriumRewardClaimParameters,
  options: ToriumReadActionOptions = {}
): Promise<ToriumRewardClaimPreflight> {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  const leaf: ToriumRewardClaimLeaf = {
    epochId: assertToriumUint256(parameters.epochId),
    index: assertToriumUint256(parameters.index),
    account: getAddress(parameters.account),
    amount: assertToriumUint256(parameters.amount),
  };
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const blockers: ToriumRewardClaimBlocker[] = [];

      let computedRootHash: Hash | null = null;
      let computedRootSum: bigint | null = null;
      try {
        const computed = processToriumRewardProof(leaf, parameters.proof);
        computedRootHash = computed.rootHash;
        computedRootSum = computed.rootSum;
      } catch {
        blockers.push("malformed-proof");
      }

      const [rawEpoch, rawClaimed, rawPaused, block] = await Promise.all([
        readRewardFunction(client, deployment, "epochs", [leaf.epochId]),
        readRewardFunction(client, deployment, "isClaimed", [
          leaf.epochId,
          leaf.index,
        ]),
        readRewardFunction(client, deployment, "paused"),
        client.getBlock({ blockTag: "latest" }),
      ]);
      signal.throwIfAborted();

      const epoch = parseRewardEpoch(rawEpoch, deployment, leaf.epochId);
      const alreadyClaimed = parseBooleanValue(
        rawClaimed,
        deployment,
        "isClaimed"
      );
      const paused = parseBooleanValue(rawPaused, deployment, "paused");
      const currentTimestamp = parseUint(
        block.timestamp,
        deployment,
        "block.timestamp"
      );

      if (paused) blockers.push("distributor-paused");
      if (epoch === null) {
        blockers.push("epoch-not-found");
      } else {
        if (currentTimestamp < epoch.claimStart) {
          blockers.push("claim-not-started");
        }
        if (currentTimestamp >= epoch.claimEnd) {
          blockers.push("claim-window-closed");
        }
        if (
          computedRootHash !== null &&
          (computedRootHash !== epoch.rootHash ||
            computedRootSum !== epoch.funded)
        ) {
          blockers.push("invalid-proof");
        }
      }
      if (alreadyClaimed) blockers.push("already-claimed");

      return Object.freeze({
        canClaim: blockers.length === 0,
        blockers: Object.freeze(blockers),
        epoch,
        currentTimestamp,
        computedRootHash,
        computedRootSum,
      });
    },
    {
      operation: "preflightToriumRewardClaim",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export interface PrepareToriumRewardClaimParameters extends ToriumRewardDistributorReadParameters {
  readonly sender: ToriumTransactionRequest["account"];
  readonly epochId: bigint;
  readonly index: bigint;
  readonly account: Address;
  readonly amount: bigint;
  readonly proof: readonly ToriumRewardProofNode[];
}

/** Encodes a `claim` transaction request for the wallet preflight/send steps. */
export function prepareToriumRewardClaim(
  parameters: PrepareToriumRewardClaimParameters
): ToriumTransactionRequest {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  return Object.freeze({
    account: parameters.sender,
    to: deployment.address,
    value: 0n,
    data: encodeFunctionData({
      abi: toriumRewardDistributorAbi,
      functionName: "claim",
      args: [
        assertToriumUint256(parameters.epochId),
        assertToriumUint256(parameters.index),
        getAddress(parameters.account),
        assertToriumUint256(parameters.amount),
        parameters.proof.map((node) => ({
          nodeHash: node.nodeHash,
          sum: assertToriumUint256(node.sum),
        })),
      ],
    }),
  });
}

export interface PrepareToriumRewardEpochPublicationParameters extends ToriumRewardDistributorReadParameters {
  readonly sender: ToriumTransactionRequest["account"];
  readonly epochId: bigint;
  readonly rootHash: Hash;
  readonly rootSum: bigint;
  readonly claimStart: bigint;
  readonly claimEnd: bigint;
}

/**
 * Encodes a `publishEpoch` request. The attached value equals the root sum
 * because the contract requires exact publication funding.
 */
export function prepareToriumRewardEpochPublication(
  parameters: PrepareToriumRewardEpochPublicationParameters
): ToriumTransactionRequest {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  const rootSum = assertToriumUint256(parameters.rootSum);
  if (parameters.rootHash === zeroHash) {
    throw new RangeError("Torium reward epoch root hash must not be zero.");
  }
  return Object.freeze({
    account: parameters.sender,
    to: deployment.address,
    value: rootSum,
    data: encodeFunctionData({
      abi: toriumRewardDistributorAbi,
      functionName: "publishEpoch",
      args: [
        assertToriumUint256(parameters.epochId),
        parameters.rootHash,
        rootSum,
        assertUint64(parameters.claimStart, "claim start"),
        assertUint64(parameters.claimEnd, "claim end"),
      ],
    }),
  });
}

export interface PrepareToriumRewardClawbackParameters extends ToriumRewardDistributorReadParameters {
  readonly sender: ToriumTransactionRequest["account"];
  readonly epochId: bigint;
}

/** Encodes a `clawback` request for the fixed-treasury expiry sweep. */
export function prepareToriumRewardClawback(
  parameters: PrepareToriumRewardClawbackParameters
): ToriumTransactionRequest {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: parameters.deployment }
  );
  return Object.freeze({
    account: parameters.sender,
    to: deployment.address,
    value: 0n,
    data: encodeFunctionData({
      abi: toriumRewardDistributorAbi,
      functionName: "clawback",
      args: [assertToriumUint256(parameters.epochId)],
    }),
  });
}

// --- Attestation registry ---------------------------------------------------

export const toriumAttestationStatuses = [
  "missing",
  "active",
  "superseded",
  "revoked",
] as const;

export type ToriumAttestationStatus =
  (typeof toriumAttestationStatuses)[number];

export interface ToriumAttestationPayload {
  readonly schemaId: Hash;
  readonly schemaVersion: number;
  readonly subject: Hash;
  readonly referenceHash?: Hash;
  readonly contentHash: Hash;
  readonly metadataHash: Hash;
  readonly metadataUriHash: Hash;
}

export interface ToriumAttestation {
  readonly attestationId: Hash;
  readonly status: ToriumAttestationStatus;
  readonly schemaId: Hash;
  readonly schemaVersion: number;
  readonly issuer: Address;
  readonly issuerNonce: bigint;
  readonly subject: Hash;
  readonly referenceHash: Hash;
  readonly contentHash: Hash;
  readonly metadataHash: Hash;
  readonly metadataUriHash: Hash;
  readonly supersedes: Hash;
  readonly supersededBy: Hash;
  readonly createdAt: bigint;
  readonly revokedAt: bigint;
  readonly supersededAt: bigint;
  readonly revocationReasonHash: Hash;
}

/** Hashes exact UTF-8 bytes under the canonical-bytes-v1 attestation rule. */
export function hashToriumAttestationUtf8(value: string): Hash {
  return keccak256(toBytes(value));
}

/**
 * Validates payload fields exactly as the registry's `_validatePayload`, so
 * client-side mistakes fail before any transaction is prepared.
 */
export function validateToriumAttestationPayload(
  payload: ToriumAttestationPayload
): void {
  if (payload.schemaId === zeroHash) {
    throw new RangeError("Torium attestation schema ID must not be zero.");
  }
  if (
    !Number.isInteger(payload.schemaVersion) ||
    payload.schemaVersion < 1 ||
    payload.schemaVersion > 0xffffffff
  ) {
    throw new RangeError(
      "Torium attestation schema version must be a uint32 from 1 upward."
    );
  }
  if (payload.subject === zeroHash) {
    throw new RangeError("Torium attestation subject must not be zero.");
  }
  if (payload.contentHash === zeroHash) {
    throw new RangeError("Torium attestation content hash must not be zero.");
  }
  if (payload.metadataHash === zeroHash) {
    throw new RangeError("Torium attestation metadata hash must not be zero.");
  }
  if (payload.metadataUriHash === zeroHash) {
    throw new RangeError(
      "Torium attestation metadata URI hash must not be zero."
    );
  }
}

/** Mirrors `computeCommitment`, including the optional supersession edge. */
export function computeToriumAttestationCommitment(
  payload: ToriumAttestationPayload,
  supersedes: Hash = zeroHash
): Hash {
  validateToriumAttestationPayload(payload);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        payload.schemaId,
        payload.schemaVersion,
        payload.subject,
        payload.referenceHash ?? zeroHash,
        payload.contentHash,
        payload.metadataHash,
        payload.metadataUriHash,
        supersedes,
      ]
    )
  );
}

/** Mirrors `computeReplayKey`; supersession is intentionally excluded. */
export function computeToriumAttestationReplayKey(
  issuer: Address,
  payload: ToriumAttestationPayload
): Hash {
  validateToriumAttestationPayload(payload);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        getAddress(issuer),
        payload.schemaId,
        payload.schemaVersion,
        payload.subject,
        payload.referenceHash ?? zeroHash,
        payload.contentHash,
        payload.metadataHash,
        payload.metadataUriHash,
      ]
    )
  );
}

export interface ComputeToriumAttestationIdParameters {
  readonly chainId: bigint | number;
  readonly registry: Address;
  readonly issuer: Address;
  readonly issuerNonce: bigint;
  readonly commitment: Hash;
}

/** Mirrors the domain-separated `computeAttestationId` derivation. */
export function computeToriumAttestationId(
  parameters: ComputeToriumAttestationIdParameters
): Hash {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        assertToriumUint256(BigInt(parameters.chainId)),
        getAddress(parameters.registry),
        getAddress(parameters.issuer),
        assertToriumUint256(parameters.issuerNonce),
        parameters.commitment,
      ]
    )
  );
}

export interface ToriumAttestationReadParameters {
  readonly deployment?: ToriumContractDeploymentOverride;
}

export interface GetToriumAttestationParameters extends ToriumAttestationReadParameters {
  readonly attestationId: Hash;
}

export async function getToriumAttestationStatus(
  client: ToriumContractReadClient,
  parameters: GetToriumAttestationParameters,
  options: ToriumReadActionOptions = {}
): Promise<ToriumAttestationStatus> {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const raw = await readAttestationFunction(
        client,
        deployment,
        "statusOf",
        [parameters.attestationId]
      );
      return parseAttestationStatus(raw, deployment);
    },
    {
      operation: "getToriumAttestationStatus",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export async function isToriumAttestationActive(
  client: ToriumContractReadClient,
  parameters: GetToriumAttestationParameters,
  options: ToriumReadActionOptions = {}
): Promise<boolean> {
  return (
    (await getToriumAttestationStatus(client, parameters, options)) === "active"
  );
}

export async function getToriumAttestation(
  client: ToriumContractReadClient,
  parameters: GetToriumAttestationParameters,
  options: ToriumReadActionOptions = {}
): Promise<ToriumAttestation | null> {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const status = parseAttestationStatus(
        await readAttestationFunction(client, deployment, "statusOf", [
          parameters.attestationId,
        ]),
        deployment
      );
      if (status === "missing") return null;
      signal.throwIfAborted();
      const raw = await readAttestationFunction(
        client,
        deployment,
        "getAttestation",
        [parameters.attestationId]
      );
      return parseAttestation(
        raw,
        deployment,
        parameters.attestationId,
        status
      );
    },
    {
      operation: "getToriumAttestation",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export interface VerifyToriumAttestationParameters extends ToriumAttestationReadParameters {
  readonly attestationId: Hash;
  readonly expectedIssuer: Address;
  readonly expectedCommitment: Hash;
}

/** Runs the on-chain `verify` check for an active, matching commitment. */
export async function verifyToriumAttestation(
  client: ToriumContractReadClient,
  parameters: VerifyToriumAttestationParameters,
  options: ToriumReadActionOptions = {}
): Promise<boolean> {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const raw = await readAttestationFunction(client, deployment, "verify", [
        parameters.attestationId,
        getAddress(parameters.expectedIssuer),
        parameters.expectedCommitment,
      ]);
      return parseBooleanValue(raw, deployment, "verify");
    },
    {
      operation: "verifyToriumAttestation",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export type ToriumAttestationBlocker =
  | "duplicate-payload"
  | "supersedes-not-found"
  | "supersedes-not-active"
  | "supersedes-issuer-mismatch"
  | "supersedes-schema-mismatch"
  | "supersedes-subject-mismatch";

export interface ToriumAttestationPreflight {
  readonly canAttest: boolean;
  readonly blockers: readonly ToriumAttestationBlocker[];
  readonly replayKey: Hash;
  readonly predictedIssuerNonce: bigint;
  readonly predictedCommitment: Hash;
  readonly predictedAttestationId: Hash;
}

export interface ToriumAttestationPreflightClient extends ToriumContractReadClient {
  getChainId(): Promise<number>;
}

export interface PreflightToriumAttestationParameters extends ToriumAttestationReadParameters {
  readonly issuer: Address;
  readonly payload: ToriumAttestationPayload;
  readonly supersedes?: Hash;
}

/**
 * Predicts the attestation identity and checks replay and supersession rules
 * before any transaction is prepared or signed.
 */
export async function preflightToriumAttestation(
  client: ToriumAttestationPreflightClient,
  parameters: PreflightToriumAttestationParameters,
  options: ToriumReadActionOptions = {}
): Promise<ToriumAttestationPreflight> {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  const issuer = getAddress(parameters.issuer);
  const supersedes = parameters.supersedes ?? zeroHash;
  const replayKey = computeToriumAttestationReplayKey(
    issuer,
    parameters.payload
  );
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const blockers: ToriumAttestationBlocker[] = [];
      const [rawUsed, rawNonce, chainId] = await Promise.all([
        readAttestationFunction(client, deployment, "usedPayloads", [
          replayKey,
        ]),
        readAttestationFunction(client, deployment, "issuerNonces", [issuer]),
        client.getChainId(),
      ]);
      signal.throwIfAborted();
      if (parseBooleanValue(rawUsed, deployment, "usedPayloads")) {
        blockers.push("duplicate-payload");
      }

      if (supersedes !== zeroHash) {
        const status = parseAttestationStatus(
          await readAttestationFunction(client, deployment, "statusOf", [
            supersedes,
          ]),
          deployment
        );
        signal.throwIfAborted();
        if (status === "missing") {
          blockers.push("supersedes-not-found");
        } else if (status !== "active") {
          blockers.push("supersedes-not-active");
        } else {
          const prior = parseAttestation(
            await readAttestationFunction(
              client,
              deployment,
              "getAttestation",
              [supersedes]
            ),
            deployment,
            supersedes,
            status
          );
          signal.throwIfAborted();
          if (prior.issuer !== issuer) {
            blockers.push("supersedes-issuer-mismatch");
          }
          if (prior.schemaId !== parameters.payload.schemaId) {
            blockers.push("supersedes-schema-mismatch");
          }
          if (prior.subject !== parameters.payload.subject) {
            blockers.push("supersedes-subject-mismatch");
          }
        }
      }

      const predictedIssuerNonce =
        parseUint(rawNonce, deployment, "issuerNonces") + 1n;
      const predictedCommitment = computeToriumAttestationCommitment(
        parameters.payload,
        supersedes
      );
      return Object.freeze({
        canAttest: blockers.length === 0,
        blockers: Object.freeze(blockers),
        replayKey,
        predictedIssuerNonce,
        predictedCommitment,
        predictedAttestationId: computeToriumAttestationId({
          chainId,
          registry: deployment.address,
          issuer,
          issuerNonce: predictedIssuerNonce,
          commitment: predictedCommitment,
        }),
      });
    },
    {
      operation: "preflightToriumAttestation",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export type ToriumAttestationRevocationBlocker =
  | "attestation-not-found"
  | "attestation-not-active"
  | "issuer-mismatch";

export interface ToriumAttestationRevocationPreflight {
  readonly canRevoke: boolean;
  readonly blockers: readonly ToriumAttestationRevocationBlocker[];
  readonly status: ToriumAttestationStatus;
}

export interface PreflightToriumAttestationRevocationParameters extends ToriumAttestationReadParameters {
  readonly attestationId: Hash;
  readonly issuer: Address;
}

export async function preflightToriumAttestationRevocation(
  client: ToriumContractReadClient,
  parameters: PreflightToriumAttestationRevocationParameters,
  options: ToriumReadActionOptions = {}
): Promise<ToriumAttestationRevocationPreflight> {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  const issuer = getAddress(parameters.issuer);
  return runToriumReadAction(
    async ({ signal }) => {
      signal.throwIfAborted();
      const blockers: ToriumAttestationRevocationBlocker[] = [];
      const status = parseAttestationStatus(
        await readAttestationFunction(client, deployment, "statusOf", [
          parameters.attestationId,
        ]),
        deployment
      );
      signal.throwIfAborted();
      if (status === "missing") {
        blockers.push("attestation-not-found");
      } else if (status !== "active") {
        blockers.push("attestation-not-active");
      } else {
        const attestation = parseAttestation(
          await readAttestationFunction(client, deployment, "getAttestation", [
            parameters.attestationId,
          ]),
          deployment,
          parameters.attestationId,
          status
        );
        if (attestation.issuer !== issuer) blockers.push("issuer-mismatch");
      }
      return Object.freeze({
        canRevoke: blockers.length === 0,
        blockers: Object.freeze(blockers),
        status,
      });
    },
    {
      operation: "preflightToriumAttestationRevocation",
      clientKind: "contract",
      method: "eth_call",
    },
    options
  );
}

export interface PrepareToriumAttestationParameters extends ToriumAttestationReadParameters {
  readonly sender: ToriumTransactionRequest["account"];
  readonly payload: ToriumAttestationPayload;
  readonly supersedes?: Hash;
}

/** Encodes an `attest` request; the sender is always the issuer on-chain. */
export function prepareToriumAttestation(
  parameters: PrepareToriumAttestationParameters
): ToriumTransactionRequest {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  validateToriumAttestationPayload(parameters.payload);
  return Object.freeze({
    account: parameters.sender,
    to: deployment.address,
    value: 0n,
    data: encodeFunctionData({
      abi: toriumAttestationRegistryAbi,
      functionName: "attest",
      args: [
        parameters.payload.schemaId,
        parameters.payload.schemaVersion,
        parameters.payload.subject,
        parameters.payload.referenceHash ?? zeroHash,
        parameters.payload.contentHash,
        parameters.payload.metadataHash,
        parameters.payload.metadataUriHash,
        parameters.supersedes ?? zeroHash,
      ],
    }),
  });
}

export interface PrepareToriumAttestationRevocationParameters extends ToriumAttestationReadParameters {
  readonly sender: ToriumTransactionRequest["account"];
  readonly attestationId: Hash;
  readonly revocationReasonHash: Hash;
}

/** Encodes a `revoke` request; only the original issuer can execute it. */
export function prepareToriumAttestationRevocation(
  parameters: PrepareToriumAttestationRevocationParameters
): ToriumTransactionRequest {
  const deployment = resolveToriumContractDeployment(
    "toriumAttestationRegistry",
    { deployment: parameters.deployment }
  );
  if (parameters.revocationReasonHash === zeroHash) {
    throw new RangeError(
      "Torium attestation revocation reason hash must not be zero."
    );
  }
  return Object.freeze({
    account: parameters.sender,
    to: deployment.address,
    value: 0n,
    data: encodeFunctionData({
      abi: toriumAttestationRegistryAbi,
      functionName: "revoke",
      args: [parameters.attestationId, parameters.revocationReasonHash],
    }),
  });
}

// --- Shared parsing helpers -------------------------------------------------

async function readRewardFunction(
  client: ToriumContractReadClient,
  deployment: ToriumContractDeployment,
  functionName: string,
  args?: readonly unknown[]
): Promise<unknown> {
  return client.readContract({
    address: deployment.address,
    abi: toriumRewardDistributorAbi,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
}

async function readAttestationFunction(
  client: ToriumContractReadClient,
  deployment: ToriumContractDeployment,
  functionName: string,
  args?: readonly unknown[]
): Promise<unknown> {
  return client.readContract({
    address: deployment.address,
    abi: toriumAttestationRegistryAbi,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
}

function parseRewardEpoch(
  raw: unknown,
  deployment: ToriumContractDeployment,
  epochId: bigint
): ToriumRewardEpoch | null {
  if (!Array.isArray(raw) || raw.length !== 6) {
    throw invalidContractResponse(
      deployment.contractName,
      "epochs",
      "getToriumRewardEpoch"
    );
  }
  const rootHash = parseHashValue(raw[0], deployment, "epochs.rootHash");
  if (rootHash === zeroHash) return null;
  return Object.freeze({
    epochId,
    rootHash,
    funded: parseUint(raw[1], deployment, "epochs.funded"),
    claimStart: parseUint(raw[2], deployment, "epochs.claimStart"),
    claimEnd: parseUint(raw[3], deployment, "epochs.claimEnd"),
    claimed: parseUint(raw[4], deployment, "epochs.claimed"),
    clawed: parseUint(raw[5], deployment, "epochs.clawed"),
  });
}

function parseAttestation(
  raw: unknown,
  deployment: ToriumContractDeployment,
  attestationId: Hash,
  status: ToriumAttestationStatus
): ToriumAttestation {
  const record = isObjectLike(raw) ? raw : null;
  if (record === null) {
    throw invalidContractResponse(
      deployment.contractName,
      "getAttestation",
      "getToriumAttestation"
    );
  }
  const schemaVersion = parseUint(
    record["schemaVersion"],
    deployment,
    "attestation.schemaVersion"
  );
  return Object.freeze({
    attestationId,
    status,
    schemaId: parseHashValue(
      record["schemaId"],
      deployment,
      "attestation.schemaId"
    ),
    schemaVersion: Number(schemaVersion),
    issuer: parseAddressValue(
      record["issuer"],
      deployment,
      "attestation.issuer"
    ),
    issuerNonce: parseUint(
      record["issuerNonce"],
      deployment,
      "attestation.issuerNonce"
    ),
    subject: parseHashValue(
      record["subject"],
      deployment,
      "attestation.subject"
    ),
    referenceHash: parseHashValue(
      record["referenceHash"],
      deployment,
      "attestation.referenceHash"
    ),
    contentHash: parseHashValue(
      record["contentHash"],
      deployment,
      "attestation.contentHash"
    ),
    metadataHash: parseHashValue(
      record["metadataHash"],
      deployment,
      "attestation.metadataHash"
    ),
    metadataUriHash: parseHashValue(
      record["metadataUriHash"],
      deployment,
      "attestation.metadataUriHash"
    ),
    supersedes: parseHashValue(
      record["supersedes"],
      deployment,
      "attestation.supersedes"
    ),
    supersededBy: parseHashValue(
      record["supersededBy"],
      deployment,
      "attestation.supersededBy"
    ),
    createdAt: parseUint(
      record["createdAt"],
      deployment,
      "attestation.createdAt"
    ),
    revokedAt: parseUint(
      record["revokedAt"],
      deployment,
      "attestation.revokedAt"
    ),
    supersededAt: parseUint(
      record["supersededAt"],
      deployment,
      "attestation.supersededAt"
    ),
    revocationReasonHash: parseHashValue(
      record["revocationReasonHash"],
      deployment,
      "attestation.revocationReasonHash"
    ),
  });
}

function parseAttestationStatus(
  raw: unknown,
  deployment: ToriumContractDeployment
): ToriumAttestationStatus {
  const index =
    typeof raw === "number" && Number.isInteger(raw)
      ? raw
      : typeof raw === "bigint"
        ? Number(raw)
        : -1;
  const status = toriumAttestationStatuses[index];
  if (status === undefined) {
    throw invalidContractResponse(
      deployment.contractName,
      "statusOf",
      "getToriumAttestationStatus"
    );
  }
  return status;
}

function parseUint(
  value: unknown,
  deployment: ToriumContractDeployment,
  label: string
): bigint {
  if (typeof value === "bigint" && value >= 0n) {
    return assertToriumUint256(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw invalidContractResponse(deployment.contractName, label);
}

function parseBooleanValue(
  value: unknown,
  deployment: ToriumContractDeployment,
  label: string
): boolean {
  if (typeof value !== "boolean") {
    throw invalidContractResponse(deployment.contractName, label);
  }
  return value;
}

function parseHashValue(
  value: unknown,
  deployment: ToriumContractDeployment,
  label: string
): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw invalidContractResponse(deployment.contractName, label);
  }
  return value.toLowerCase() as Hash;
}

function parseAddressValue(
  value: unknown,
  deployment: ToriumContractDeployment,
  label: string
): Address {
  if (typeof value !== "string") {
    throw invalidContractResponse(deployment.contractName, label);
  }
  try {
    return getAddress(value);
  } catch {
    throw invalidContractResponse(deployment.contractName, label);
  }
}

function invalidContractResponse(
  contractName: ToriumContractName,
  label: string,
  operation?: string
): ToriumContractError {
  return new ToriumContractError(
    "TORIUM_CONTRACT_RESPONSE_INVALID",
    `The endpoint returned an invalid ${contractName} ${label} response.`,
    { contractName, operation, method: "eth_call" }
  );
}

function normalizeContractAddress(
  contractName: ToriumContractName,
  value: string
): Address {
  try {
    return getAddress(value);
  } catch (error) {
    throw new ToriumContractError(
      "TORIUM_CONTRACT_CONFIG_INVALID",
      `The ${contractName} deployment address is not a valid EVM address.`,
      { contractName, cause: error }
    );
  }
}

function assertUint64(value: bigint, label: string): bigint {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`Torium ${label} must fit in a uint64.`);
  }
  return value;
}

function isObjectLike(
  value: unknown
): value is Record<string | number, unknown> {
  return typeof value === "object" && value !== null;
}
