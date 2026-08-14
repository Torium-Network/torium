// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Torium native reward distributor
/// @notice Distributes fully funded native rewards through immutable Merkle-sum epochs.
/// @dev The publisher remains trusted for dataset truth. The Merkle-sum root makes the
///      aggregate liability independently verifiable and binds it to exact publication funding.
contract ToriumRewardDistributor is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    struct Epoch {
        bytes32 rootHash;
        uint256 funded;
        uint64 claimStart;
        uint64 claimEnd;
        uint256 claimed;
        uint256 clawed;
    }

    struct ProofNode {
        bytes32 nodeHash;
        uint256 sum;
    }

    error ZeroAddress();
    error ZeroDelay();
    error ZeroRootHash();
    error ZeroFunding();
    error ZeroAmount();
    error UnexpectedEpochId(uint256 expectedEpochId, uint256 actualEpochId);
    error EpochNotFound(uint256 epochId);
    error RootHashAlreadyUsed(bytes32 rootHash);
    error FundingDoesNotMatchRootSum(uint256 funding, uint256 rootSum);
    error ClaimStartTooEarly(uint256 minimumStart, uint256 actualStart);
    error InvalidClaimWindow(uint256 claimStart, uint256 claimEnd);
    error ClaimNotStarted(uint256 claimStart, uint256 currentTime);
    error ClaimWindowClosed(uint256 claimEnd, uint256 currentTime);
    error ClaimAlreadyProcessed(uint256 epochId, uint256 index);
    error MalformedProof(uint256 proofIndex);
    error InvalidProof(bytes32 computedRootHash, uint256 computedRootSum);
    error ClawbackNotReady(uint256 availableAt, uint256 currentTime);
    error NothingToClawback(uint256 epochId);
    error NativeTransferFailed(address recipient, uint256 amount);
    error AccountingInsolvent(uint256 nativeBalance, uint256 outstanding);

    event EpochPublished(
        uint256 indexed epochId,
        bytes32 indexed rootHash,
        address indexed publisher,
        uint256 funded,
        uint64 claimStart,
        uint64 claimEnd
    );
    event RewardClaimed(
        uint256 indexed epochId,
        uint256 indexed index,
        address indexed account,
        uint256 amount,
        uint256 epochClaimed,
        uint256 totalClaimed
    );
    event EpochClawedBack(
        uint256 indexed epochId,
        address indexed operator,
        address indexed treasury,
        uint256 amount,
        uint256 epochClawed,
        uint256 totalClawed
    );
    event AccountingReconciled(
        uint256 indexed epochId,
        uint256 epochOutstanding,
        uint256 totalOutstanding,
        uint256 nativeBalance,
        uint256 forcedSurplus
    );

    bytes32 public constant EPOCH_PUBLISHER_ROLE = keccak256("EPOCH_PUBLISHER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant CLAWBACK_ROLE = keccak256("CLAWBACK_ROLE");

    /// @dev These trust and timing choices have no mutation entrypoints.
    address payable public treasury;
    uint64 public publicationDelay;
    uint64 public clawbackDelay;

    uint256 public nextEpochId = 1;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public totalClawed;

    mapping(uint256 epochId => Epoch epoch) public epochs;
    mapping(bytes32 rootHash => bool used) private _usedRootHashes;
    mapping(uint256 epochId => mapping(uint256 wordIndex => uint256 word)) private _claimedBitMaps;

    constructor(
        uint48 defaultAdminDelay_,
        address initialAdmin_,
        address initialPublisher_,
        address initialPauser_,
        address initialClawbackOperator_,
        address payable treasury_,
        uint64 publicationDelay_,
        uint64 clawbackDelay_
    ) AccessControlDefaultAdminRules(defaultAdminDelay_, initialAdmin_) {
        if (
            initialAdmin_ == address(0) || initialPublisher_ == address(0) || initialPauser_ == address(0)
                || initialClawbackOperator_ == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (defaultAdminDelay_ == 0 || publicationDelay_ == 0 || clawbackDelay_ == 0) {
            revert ZeroDelay();
        }

        treasury = treasury_;
        publicationDelay = publicationDelay_;
        clawbackDelay = clawbackDelay_;

        _grantRole(EPOCH_PUBLISHER_ROLE, initialPublisher_);
        _grantRole(PAUSER_ROLE, initialPauser_);
        _grantRole(CLAWBACK_ROLE, initialClawbackOperator_);
    }

    /// @notice Publishes the next immutable epoch and funds its committed root sum exactly.
    function publishEpoch(uint256 epochId, bytes32 rootHash, uint256 rootSum, uint64 claimStart, uint64 claimEnd)
        external
        payable
        onlyRole(EPOCH_PUBLISHER_ROLE)
        whenNotPaused
    {
        uint256 expectedEpochId = nextEpochId;
        if (epochId != expectedEpochId) revert UnexpectedEpochId(expectedEpochId, epochId);
        if (rootHash == bytes32(0)) revert ZeroRootHash();
        if (_usedRootHashes[rootHash]) revert RootHashAlreadyUsed(rootHash);
        if (rootSum == 0 || msg.value == 0) revert ZeroFunding();
        if (msg.value != rootSum) revert FundingDoesNotMatchRootSum(msg.value, rootSum);

        uint256 minimumStart = block.timestamp + publicationDelay;
        if (claimStart < minimumStart) revert ClaimStartTooEarly(minimumStart, claimStart);
        if (claimEnd <= claimStart) revert InvalidClaimWindow(claimStart, claimEnd);

        epochs[epochId] = Epoch({
            rootHash: rootHash, funded: rootSum, claimStart: claimStart, claimEnd: claimEnd, claimed: 0, clawed: 0
        });
        _usedRootHashes[rootHash] = true;
        nextEpochId = expectedEpochId + 1;
        totalFunded += rootSum;

        emit EpochPublished(epochId, rootHash, msg.sender, rootSum, claimStart, claimEnd);
        _emitAccounting(epochId, rootSum);
    }

    /// @notice Claims an amount whose Merkle-sum path reconstructs the funded epoch root.
    function claim(uint256 epochId, uint256 index, address payable account, uint256 amount, ProofNode[] calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        Epoch storage epoch = _requireEpoch(epochId);
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 currentTime = block.timestamp;
        if (currentTime < epoch.claimStart) {
            revert ClaimNotStarted(epoch.claimStart, currentTime);
        }
        if (currentTime >= epoch.claimEnd) {
            revert ClaimWindowClosed(epoch.claimEnd, currentTime);
        }
        if (isClaimed(epochId, index)) revert ClaimAlreadyProcessed(epochId, index);

        (bytes32 computedRootHash, uint256 computedRootSum) = processProof(epochId, index, account, amount, proof);
        if (computedRootHash != epoch.rootHash || computedRootSum != epoch.funded) {
            revert InvalidProof(computedRootHash, computedRootSum);
        }

        _setClaimed(epochId, index);
        epoch.claimed += amount;
        totalClaimed += amount;

        (bool success,) = account.call{value: amount}("");
        if (!success) revert NativeTransferFailed(account, amount);

        emit RewardClaimed(epochId, index, account, amount, epoch.claimed, totalClaimed);
        _emitAccounting(epochId, _remaining(epoch));
    }

    /// @notice Sends an expired epoch's unclaimed liability only to the fixed treasury.
    function clawback(uint256 epochId)
        external
        onlyRole(CLAWBACK_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 amount)
    {
        Epoch storage epoch = _requireEpoch(epochId);
        uint256 availableAt = uint256(epoch.claimEnd) + clawbackDelay;
        uint256 currentTime = block.timestamp;
        if (currentTime < availableAt) revert ClawbackNotReady(availableAt, currentTime);

        amount = _remaining(epoch);
        if (amount == 0) revert NothingToClawback(epochId);

        epoch.clawed += amount;
        totalClawed += amount;

        (bool success,) = treasury.call{value: amount}("");
        if (!success) revert NativeTransferFailed(treasury, amount);

        emit EpochClawedBack(epochId, msg.sender, treasury, amount, epoch.clawed, totalClawed);
        _emitAccounting(epochId, 0);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Hashes a leaf exactly as committed by the Merkle-sum fixture.
    function leafHash(uint256 epochId, uint256 index, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(epochId, index, account, amount));
    }

    /// @notice Sorts a pair by hash and commits both child sums in the parent hash.
    function hashNode(bytes32 firstHash, uint256 firstSum, bytes32 secondHash, uint256 secondSum)
        public
        pure
        returns (bytes32 parentHash, uint256 parentSum)
    {
        parentSum = firstSum + secondSum;
        if (firstHash < secondHash || firstHash == secondHash) {
            parentHash = keccak256(abi.encode(firstHash, firstSum, secondHash, secondSum));
        } else {
            parentHash = keccak256(abi.encode(secondHash, secondSum, firstHash, firstSum));
        }
    }

    /// @notice Reconstructs both the Merkle root hash and aggregate sum for a claim.
    function processProof(uint256 epochId, uint256 index, address account, uint256 amount, ProofNode[] calldata proof)
        public
        pure
        returns (bytes32 computedRootHash, uint256 computedRootSum)
    {
        computedRootHash = leafHash(epochId, index, account, amount);
        computedRootSum = amount;

        uint256 proofLength = proof.length;
        for (uint256 proofIndex = 0; proofIndex < proofLength; ++proofIndex) {
            ProofNode calldata sibling = proof[proofIndex];
            if (sibling.nodeHash == bytes32(0) || sibling.sum == 0) {
                revert MalformedProof(proofIndex);
            }
            (computedRootHash, computedRootSum) =
                hashNode(computedRootHash, computedRootSum, sibling.nodeHash, sibling.sum);
        }
    }

    function isClaimed(uint256 epochId, uint256 index) public view returns (bool) {
        uint256 word = _claimedBitMaps[epochId][index >> 8];
        // forge-lint: disable-next-line(incorrect-shift)
        uint256 mask = 1 << (index & 255);
        return word & mask == mask;
    }

    function isRootHashUsed(bytes32 rootHash) external view returns (bool) {
        return _usedRootHashes[rootHash];
    }

    function remainingForEpoch(uint256 epochId) public view returns (uint256) {
        return _remaining(_requireEpoch(epochId));
    }

    function totalOutstanding() public view returns (uint256) {
        return totalFunded - totalClaimed - totalClawed;
    }

    function forcedSurplus() public view returns (uint256) {
        uint256 outstanding = totalOutstanding();
        uint256 nativeBalance = address(this).balance;
        if (nativeBalance < outstanding) revert AccountingInsolvent(nativeBalance, outstanding);
        return nativeBalance - outstanding;
    }

    function clawbackAvailableAt(uint256 epochId) external view returns (uint256) {
        Epoch storage epoch = _requireEpoch(epochId);
        return uint256(epoch.claimEnd) + clawbackDelay;
    }

    function _setClaimed(uint256 epochId, uint256 index) private {
        uint256 wordIndex = index >> 8;
        // forge-lint: disable-next-line(incorrect-shift)
        uint256 mask = 1 << (index & 255);
        _claimedBitMaps[epochId][wordIndex] |= mask;
    }

    function _requireEpoch(uint256 epochId) private view returns (Epoch storage epoch) {
        epoch = epochs[epochId];
        if (epoch.rootHash == bytes32(0)) revert EpochNotFound(epochId);
    }

    function _remaining(Epoch storage epoch) private view returns (uint256) {
        return epoch.funded - epoch.claimed - epoch.clawed;
    }

    function _emitAccounting(uint256 epochId, uint256 epochOutstanding) private {
        uint256 outstanding = totalOutstanding();
        uint256 nativeBalance = address(this).balance;
        emit AccountingReconciled(epochId, epochOutstanding, outstanding, nativeBalance, forcedSurplus());
    }
}
