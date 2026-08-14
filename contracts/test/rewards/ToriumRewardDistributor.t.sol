// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ToriumRewardDistributor} from "../../src/rewards/ToriumRewardDistributor.sol";

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function expectPartialRevert(bytes4 revertData) external;
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
}

contract RejectingNativeRecipient {
    receive() external payable {
        revert("native transfer rejected");
    }
}

contract ReentrantNativeRecipient {
    ToriumRewardDistributor private _distributor;
    uint256 private _epochId;
    uint256 private _index;
    uint256 private _amount;

    function configure(ToriumRewardDistributor distributor_, uint256 epochId_, uint256 index_, uint256 amount_)
        external
    {
        _distributor = distributor_;
        _epochId = epochId_;
        _index = index_;
        _amount = amount_;
    }

    receive() external payable {
        _distributor.claim(
            _epochId, _index, payable(address(this)), _amount, new ToriumRewardDistributor.ProofNode[](0)
        );
    }
}

contract ToriumRewardDistributorTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint48 private constant ADMIN_DELAY = 2 days;
    uint64 private constant PUBLICATION_DELAY = 1 days;
    uint64 private constant CLAWBACK_DELAY = 2 days;
    uint64 private constant CLAIM_DURATION = 7 days;

    address private constant ADMIN = address(0x1000);
    address private constant PUBLISHER = address(0x1001);
    address private constant PAUSER = address(0x1002);
    address private constant CLAWBACK_OPERATOR = address(0x1003);
    address private constant OUTSIDER = address(0x1004);
    address private constant NEW_ADMIN = address(0x1005);
    address payable private constant TREASURY = payable(address(0x2001));
    address payable private constant ALICE = payable(address(0x3001));
    address payable private constant BOB = payable(address(0x3002));

    ToriumRewardDistributor private _distributor;

    function setUp() public {
        _distributor = _newDistributor(TREASURY);
        VM.deal(PUBLISHER, type(uint128).max);
    }

    function testConstructorInstallsExplicitTrustAndRejectsUnsafeConfiguration() public {
        require(_distributor.defaultAdmin() == ADMIN, "admin mismatch");
        require(_distributor.hasRole(_distributor.EPOCH_PUBLISHER_ROLE(), PUBLISHER), "publisher missing");
        require(_distributor.hasRole(_distributor.PAUSER_ROLE(), PAUSER), "pauser missing");
        require(_distributor.hasRole(_distributor.CLAWBACK_ROLE(), CLAWBACK_OPERATOR), "clawback role missing");
        require(_distributor.treasury() == TREASURY, "treasury mismatch");
        require(_distributor.publicationDelay() == PUBLICATION_DELAY, "publication delay");
        require(_distributor.clawbackDelay() == CLAWBACK_DELAY, "clawback delay");

        VM.expectPartialRevert(ToriumRewardDistributor.ZeroDelay.selector);
        new ToriumRewardDistributor(
            0, ADMIN, PUBLISHER, PAUSER, CLAWBACK_OPERATOR, TREASURY, PUBLICATION_DELAY, CLAWBACK_DELAY
        );

        VM.expectPartialRevert(ToriumRewardDistributor.ZeroAddress.selector);
        new ToriumRewardDistributor(
            ADMIN_DELAY, ADMIN, address(0), PAUSER, CLAWBACK_OPERATOR, TREASURY, PUBLICATION_DELAY, CLAWBACK_DELAY
        );
    }

    function testLeafAndSortedNodeEncodingMatchSpecification() public view {
        bytes32 aliceLeaf = _distributor.leafHash(7, 9, ALICE, 11 ether);
        require(
            aliceLeaf == keccak256(abi.encode(uint256(7), uint256(9), ALICE, uint256(11 ether))),
            "leaf encoding mismatch"
        );

        bytes32 bobLeaf = _distributor.leafHash(7, 10, BOB, 13 ether);
        (bytes32 actualRoot, uint256 actualSum) = _distributor.hashNode(aliceLeaf, 11 ether, bobLeaf, 13 ether);
        bytes32 expectedRoot = aliceLeaf < bobLeaf
            ? keccak256(abi.encode(aliceLeaf, 11 ether, bobLeaf, 13 ether))
            : keccak256(abi.encode(bobLeaf, 13 ether, aliceLeaf, 11 ether));
        require(actualRoot == expectedRoot, "node encoding mismatch");
        require(actualSum == 24 ether, "node sum mismatch");

        (bytes32 duplicateRoot, uint256 duplicateSum) = _distributor.hashNode(aliceLeaf, 11 ether, aliceLeaf, 11 ether);
        require(
            duplicateRoot == keccak256(abi.encode(aliceLeaf, 11 ether, aliceLeaf, 11 ether)),
            "equal-hash ordering mismatch"
        );
        require(duplicateSum == 22 ether, "equal-hash sum mismatch");
    }

    function testEpochPublicationIsSequentialAndExactlyFunded() public {
        uint64 claimStart = _nextClaimStart();
        uint64 claimEnd = claimStart + CLAIM_DURATION;
        bytes32 root = keccak256("epoch-one");

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.UnexpectedEpochId.selector);
        _distributor.publishEpoch{value: 1 ether}(2, root, 1 ether, claimStart, claimEnd);

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.FundingDoesNotMatchRootSum.selector);
        _distributor.publishEpoch{value: 2 ether}(1, root, 1 ether, claimStart, claimEnd);

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.ZeroFunding.selector);
        _distributor.publishEpoch(1, root, 0, claimStart, claimEnd);

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.ZeroRootHash.selector);
        _distributor.publishEpoch{value: 1 ether}(1, bytes32(0), 1 ether, claimStart, claimEnd);

        VM.prank(PUBLISHER);
        _distributor.publishEpoch{value: 1 ether}(1, root, 1 ether, claimStart, claimEnd);
        require(_distributor.nextEpochId() == 2, "next epoch mismatch");
        require(_distributor.isRootHashUsed(root), "root usage missing");

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.RootHashAlreadyUsed.selector);
        _distributor.publishEpoch{value: 1 ether}(2, root, 1 ether, claimStart, claimEnd);

        uint256 balanceBefore = address(_distributor).balance;
        (bool success,) = address(_distributor).call{value: 1 ether}("");
        require(!success, "direct funding succeeded");
        require(address(_distributor).balance == balanceBefore, "direct funding retained");
    }

    function testPublicationRolesAndWindowsFailClosed() public {
        uint64 minimumStart = _nextClaimStart();
        bytes32 root = keccak256("window-root");

        VM.prank(OUTSIDER);
        VM.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        _distributor.publishEpoch(1, root, 1 ether, minimumStart, minimumStart + CLAIM_DURATION);

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.ClaimStartTooEarly.selector);
        _distributor.publishEpoch{value: 1 ether}(1, root, 1 ether, minimumStart - 1, minimumStart + CLAIM_DURATION);

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(ToriumRewardDistributor.InvalidClaimWindow.selector);
        _distributor.publishEpoch{value: 1 ether}(1, root, 1 ether, minimumStart, minimumStart);
    }

    function testMerkleSumClaimsReconcileExactFunding() public {
        uint256 aliceAmount = 6 ether;
        uint256 bobAmount = 9 ether;
        bytes32 aliceLeaf = _distributor.leafHash(1, 513, ALICE, aliceAmount);
        bytes32 bobLeaf = _distributor.leafHash(1, 514, BOB, bobAmount);
        (bytes32 root, uint256 rootSum) = _distributor.hashNode(aliceLeaf, aliceAmount, bobLeaf, bobAmount);
        (uint64 claimStart,) = _publish(1, root, rootSum);

        VM.warp(claimStart);
        _distributor.claim(1, 513, ALICE, aliceAmount, _proof(bobLeaf, bobAmount));
        _distributor.claim(1, 514, BOB, bobAmount, _proof(aliceLeaf, aliceAmount));

        require(ALICE.balance == aliceAmount, "alice payment mismatch");
        require(BOB.balance == bobAmount, "bob payment mismatch");
        require(_distributor.isClaimed(1, 513), "alice bitmap missing");
        require(_distributor.isClaimed(1, 514), "bob bitmap missing");
        require(_distributor.remainingForEpoch(1) == 0, "epoch liability remains");
        require(_distributor.totalFunded() == rootSum, "funding drift");
        require(_distributor.totalClaimed() == rootSum, "claim drift");
        require(_distributor.totalOutstanding() == 0, "outstanding drift");
        require(_distributor.forcedSurplus() == 0, "unexpected surplus");
    }

    function testMalformedInvalidSumTamperedAndReplayProofsFail() public {
        uint256 aliceAmount = 3 ether;
        uint256 bobAmount = 5 ether;
        bytes32 aliceLeaf = _distributor.leafHash(1, 0, ALICE, aliceAmount);
        bytes32 bobLeaf = _distributor.leafHash(1, 1, BOB, bobAmount);
        (bytes32 root, uint256 rootSum) = _distributor.hashNode(aliceLeaf, aliceAmount, bobLeaf, bobAmount);
        (uint64 claimStart,) = _publish(1, root, rootSum);
        VM.warp(claimStart);

        {
            ToriumRewardDistributor.ProofNode[] memory malformedHash = _proof(bytes32(0), bobAmount);
            VM.expectPartialRevert(ToriumRewardDistributor.MalformedProof.selector);
            _distributor.claim(1, 0, ALICE, aliceAmount, malformedHash);
        }
        {
            ToriumRewardDistributor.ProofNode[] memory malformedSum = _proof(bobLeaf, 0);
            VM.expectPartialRevert(ToriumRewardDistributor.MalformedProof.selector);
            _distributor.claim(1, 0, ALICE, aliceAmount, malformedSum);
        }
        {
            ToriumRewardDistributor.ProofNode[] memory tamperedSum = _proof(bobLeaf, bobAmount + 1);
            VM.expectPartialRevert(ToriumRewardDistributor.InvalidProof.selector);
            _distributor.claim(1, 0, ALICE, aliceAmount, tamperedSum);
        }
        {
            ToriumRewardDistributor.ProofNode[] memory wrongHash = _proof(keccak256("wrong sibling"), bobAmount);
            VM.expectPartialRevert(ToriumRewardDistributor.InvalidProof.selector);
            _distributor.claim(1, 0, ALICE, aliceAmount, wrongHash);
        }

        ToriumRewardDistributor.ProofNode[] memory validProof = _proof(bobLeaf, bobAmount);
        VM.expectPartialRevert(ToriumRewardDistributor.InvalidProof.selector);
        _distributor.claim(1, 0, BOB, aliceAmount, validProof);

        _distributor.claim(1, 0, ALICE, aliceAmount, validProof);
        VM.expectPartialRevert(ToriumRewardDistributor.ClaimAlreadyProcessed.selector);
        _distributor.claim(1, 0, ALICE, aliceAmount, validProof);
    }

    function testClaimValidationAndTimingRules() public {
        uint256 amount = 2 ether;
        (uint64 claimStart, uint64 claimEnd) = _publishSingle(1, 0, ALICE, amount);
        ToriumRewardDistributor.ProofNode[] memory emptyProof = new ToriumRewardDistributor.ProofNode[](0);

        VM.expectPartialRevert(ToriumRewardDistributor.ClaimNotStarted.selector);
        _distributor.claim(1, 0, ALICE, amount, emptyProof);

        VM.warp(claimStart);
        VM.expectPartialRevert(ToriumRewardDistributor.ZeroAddress.selector);
        _distributor.claim(1, 0, payable(address(0)), amount, emptyProof);

        VM.expectPartialRevert(ToriumRewardDistributor.ZeroAmount.selector);
        _distributor.claim(1, 0, ALICE, 0, emptyProof);

        VM.warp(claimEnd);
        VM.expectPartialRevert(ToriumRewardDistributor.ClaimWindowClosed.selector);
        _distributor.claim(1, 0, ALICE, amount, emptyProof);

        VM.expectPartialRevert(ToriumRewardDistributor.EpochNotFound.selector);
        _distributor.remainingForEpoch(999);
    }

    function testPauseAndAuthorizedUnpauseProtectEveryMutation() public {
        uint256 amount = 4 ether;
        (uint64 claimStart,) = _publishSingle(1, 0, ALICE, amount);

        VM.prank(OUTSIDER);
        VM.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        _distributor.pause();

        VM.prank(PAUSER);
        _distributor.pause();
        VM.warp(claimStart);
        VM.expectPartialRevert(bytes4(keccak256("EnforcedPause()")));
        _distributor.claim(1, 0, ALICE, amount, new ToriumRewardDistributor.ProofNode[](0));

        VM.prank(PUBLISHER);
        VM.expectPartialRevert(bytes4(keccak256("EnforcedPause()")));
        _distributor.publishEpoch{value: 1 ether}(2, keccak256("paused"), 1 ether, _nextClaimStart(), _nextClaimEnd());

        VM.prank(OUTSIDER);
        VM.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        _distributor.unpause();

        VM.prank(PAUSER);
        _distributor.unpause();
        _distributor.claim(1, 0, ALICE, amount, new ToriumRewardDistributor.ProofNode[](0));
    }

    function testDelayedFixedTreasuryClawbackReconcilesRemainder() public {
        uint256 aliceAmount = 7 ether;
        uint256 bobAmount = 8 ether;
        bytes32 aliceLeaf = _distributor.leafHash(1, 0, ALICE, aliceAmount);
        bytes32 bobLeaf = _distributor.leafHash(1, 1, BOB, bobAmount);
        (bytes32 root, uint256 total) = _distributor.hashNode(aliceLeaf, aliceAmount, bobLeaf, bobAmount);
        (uint64 claimStart, uint64 claimEnd) = _publish(1, root, total);
        VM.warp(claimStart);
        _distributor.claim(1, 0, ALICE, aliceAmount, _proof(bobLeaf, bobAmount));

        VM.prank(CLAWBACK_OPERATOR);
        VM.expectPartialRevert(ToriumRewardDistributor.ClawbackNotReady.selector);
        _distributor.clawback(1);

        uint256 availableAt = uint256(claimEnd) + CLAWBACK_DELAY;
        require(_distributor.clawbackAvailableAt(1) == availableAt, "clawback timestamp");
        VM.warp(availableAt);

        VM.prank(OUTSIDER);
        VM.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        _distributor.clawback(1);

        VM.prank(PAUSER);
        _distributor.pause();
        VM.prank(CLAWBACK_OPERATOR);
        VM.expectPartialRevert(bytes4(keccak256("EnforcedPause()")));
        _distributor.clawback(1);
        VM.prank(PAUSER);
        _distributor.unpause();

        uint256 treasuryBefore = TREASURY.balance;
        VM.prank(CLAWBACK_OPERATOR);
        uint256 clawed = _distributor.clawback(1);
        require(clawed == bobAmount, "clawback amount mismatch");
        require(TREASURY.balance == treasuryBefore + bobAmount, "treasury payment mismatch");
        require(_distributor.totalClawed() == bobAmount, "clawback total mismatch");
        require(_distributor.totalOutstanding() == 0, "clawback liability remains");

        VM.prank(CLAWBACK_OPERATOR);
        VM.expectPartialRevert(ToriumRewardDistributor.NothingToClawback.selector);
        _distributor.clawback(1);
    }

    function testRejectingAndReentrantRecipientsRollBackClaimState() public {
        uint256 amount = 1 ether;
        RejectingNativeRecipient rejecting = new RejectingNativeRecipient();
        (uint64 rejectingStart,) = _publishSingle(1, 0, payable(address(rejecting)), amount);
        VM.warp(rejectingStart);
        VM.expectPartialRevert(ToriumRewardDistributor.NativeTransferFailed.selector);
        _distributor.claim(1, 0, payable(address(rejecting)), amount, new ToriumRewardDistributor.ProofNode[](0));
        require(!_distributor.isClaimed(1, 0), "rejecting recipient consumed claim");

        ReentrantNativeRecipient reentrant = new ReentrantNativeRecipient();
        (uint64 reentrantStart,) = _publishSingle(2, 0, payable(address(reentrant)), amount);
        reentrant.configure(_distributor, 2, 0, amount);
        VM.warp(reentrantStart);
        VM.expectPartialRevert(ToriumRewardDistributor.NativeTransferFailed.selector);
        _distributor.claim(2, 0, payable(address(reentrant)), amount, new ToriumRewardDistributor.ProofNode[](0));
        require(!_distributor.isClaimed(2, 0), "reentrant recipient consumed claim");
        require(_distributor.totalClaimed() == 0, "failed transfer changed accounting");
    }

    function testRejectingTreasuryRollsBackClawbackAccounting() public {
        RejectingNativeRecipient rejectingTreasury = new RejectingNativeRecipient();
        ToriumRewardDistributor isolated = _newDistributor(payable(address(rejectingTreasury)));
        uint256 amount = 1 ether;
        uint64 claimStart = _nextClaimStart();
        uint64 claimEnd = claimStart + CLAIM_DURATION;
        bytes32 root = isolated.leafHash(1, 0, ALICE, amount);
        VM.prank(PUBLISHER);
        isolated.publishEpoch{value: amount}(1, root, amount, claimStart, claimEnd);
        VM.warp(uint256(claimEnd) + CLAWBACK_DELAY);

        VM.prank(CLAWBACK_OPERATOR);
        VM.expectPartialRevert(ToriumRewardDistributor.NativeTransferFailed.selector);
        isolated.clawback(1);
        require(isolated.totalClawed() == 0, "failed clawback changed accounting");
        require(isolated.remainingForEpoch(1) == amount, "failed clawback lost liability");
    }

    function testForcedSurplusNeverChangesEpochLiabilities() public {
        uint256 amount = 3 ether;
        uint256 surplus = 2 ether;
        (uint64 claimStart,) = _publishSingle(1, 0, ALICE, amount);
        VM.deal(address(_distributor), address(_distributor).balance + surplus);
        require(_distributor.forcedSurplus() == surplus, "surplus not isolated");
        require(_distributor.totalOutstanding() == amount, "surplus changed liability");

        VM.deal(address(_distributor), amount - 1);
        VM.expectPartialRevert(ToriumRewardDistributor.AccountingInsolvent.selector);
        _distributor.forcedSurplus();
        VM.deal(address(_distributor), amount + surplus);

        VM.warp(claimStart);
        _distributor.claim(1, 0, ALICE, amount, new ToriumRewardDistributor.ProofNode[](0));
        require(address(_distributor).balance == surplus, "claim consumed forced surplus");
        require(_distributor.forcedSurplus() == surplus, "surplus accounting drift");
    }

    function testDefaultAdminTransferRetainsConfiguredDelay() public {
        VM.prank(ADMIN);
        _distributor.beginDefaultAdminTransfer(NEW_ADMIN);

        VM.prank(NEW_ADMIN);
        (bool earlySuccess,) = address(_distributor).call(abi.encodeCall(_distributor.acceptDefaultAdminTransfer, ()));
        require(!earlySuccess, "admin delay bypassed");

        VM.warp(block.timestamp + ADMIN_DELAY + 1);
        VM.prank(NEW_ADMIN);
        _distributor.acceptDefaultAdminTransfer();
        require(_distributor.defaultAdmin() == NEW_ADMIN, "admin transfer failed");
    }

    function testFuzzSingleLeafFundingClaimAndBitmap(uint96 rawAmount, uint256 index) public {
        uint256 amount = uint256(rawAmount) + 1;
        (uint64 claimStart,) = _publishSingle(1, index, ALICE, amount);
        VM.warp(claimStart);
        _distributor.claim(1, index, ALICE, amount, new ToriumRewardDistributor.ProofNode[](0));
        require(_distributor.isClaimed(1, index), "fuzz bitmap missing");
        require(_distributor.totalFunded() == amount, "fuzz funding drift");
        require(_distributor.totalClaimed() == amount, "fuzz claim drift");
    }

    function testFuzzSiblingSumTamperingFails(uint96 rawFirst, uint96 rawSecond) public {
        uint256 first = uint256(rawFirst) + 1;
        uint256 second = uint256(rawSecond) + 1;
        bytes32 firstLeaf = _distributor.leafHash(1, 0, ALICE, first);
        bytes32 secondLeaf = _distributor.leafHash(1, 1, BOB, second);
        (bytes32 root, uint256 rootSum) = _distributor.hashNode(firstLeaf, first, secondLeaf, second);
        (uint64 claimStart,) = _publish(1, root, rootSum);
        VM.warp(claimStart);

        ToriumRewardDistributor.ProofNode[] memory tampered = _proof(secondLeaf, second + 1);
        VM.expectPartialRevert(ToriumRewardDistributor.InvalidProof.selector);
        _distributor.claim(1, 0, ALICE, first, tampered);
        require(!_distributor.isClaimed(1, 0), "tampered proof consumed bitmap");
    }

    function _newDistributor(address payable treasury_) private returns (ToriumRewardDistributor) {
        return new ToriumRewardDistributor(
            ADMIN_DELAY, ADMIN, PUBLISHER, PAUSER, CLAWBACK_OPERATOR, treasury_, PUBLICATION_DELAY, CLAWBACK_DELAY
        );
    }

    function _publishSingle(uint256 epochId, uint256 index, address account, uint256 amount)
        private
        returns (uint64 claimStart, uint64 claimEnd)
    {
        return _publish(epochId, _distributor.leafHash(epochId, index, account, amount), amount);
    }

    function _publish(uint256 epochId, bytes32 root, uint256 rootSum)
        private
        returns (uint64 claimStart, uint64 claimEnd)
    {
        claimStart = _nextClaimStart();
        claimEnd = claimStart + CLAIM_DURATION;
        VM.prank(PUBLISHER);
        _distributor.publishEpoch{value: rootSum}(epochId, root, rootSum, claimStart, claimEnd);
    }

    function _proof(bytes32 siblingHash, uint256 siblingSum)
        private
        pure
        returns (ToriumRewardDistributor.ProofNode[] memory proof)
    {
        proof = new ToriumRewardDistributor.ProofNode[](1);
        proof[0] = ToriumRewardDistributor.ProofNode({nodeHash: siblingHash, sum: siblingSum});
    }

    function _nextClaimStart() private view returns (uint64) {
        return uint64(block.timestamp + PUBLICATION_DELAY);
    }

    function _nextClaimEnd() private view returns (uint64) {
        return _nextClaimStart() + CLAIM_DURATION;
    }
}

contract RewardDistributorInvariantHandler {
    struct ClaimRecord {
        uint256 epochId;
        uint256 index;
        uint256 amount;
        bytes32 siblingHash;
        uint256 siblingSum;
        bool claimed;
    }

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address payable private constant FIRST_RECIPIENT = payable(address(0xBEEF));
    address payable private constant SECOND_RECIPIENT = payable(address(0xCAFE));

    ToriumRewardDistributor private immutable _distributor;
    ClaimRecord[] private _claims;
    uint256 public modelFunded;
    uint256 public modelClaimed;
    uint256 public modelClawed;
    uint256 public modelForcedSurplus;

    constructor(ToriumRewardDistributor distributor_) {
        _distributor = distributor_;
    }

    receive() external payable {}

    function publish(uint96 rawFirstAmount, uint96 rawSecondAmount, uint64 rawDuration) external {
        if (_distributor.paused()) return;

        uint256 firstAmount = uint256(rawFirstAmount) + 1;
        uint256 secondAmount = uint256(rawSecondAmount) + 1;
        uint256 epochId = _distributor.nextEpochId();
        uint256 index = epochId << 1;
        uint64 claimStart = uint64(block.timestamp + _distributor.publicationDelay());
        uint64 claimEnd = claimStart + uint64(1 days + rawDuration % 30 days);
        bytes32 firstLeaf = _distributor.leafHash(epochId, index, FIRST_RECIPIENT, firstAmount);
        bytes32 secondLeaf = _distributor.leafHash(epochId, index + 1, SECOND_RECIPIENT, secondAmount);
        (bytes32 root, uint256 rootSum) = _distributor.hashNode(firstLeaf, firstAmount, secondLeaf, secondAmount);

        _distributor.publishEpoch{value: rootSum}(epochId, root, rootSum, claimStart, claimEnd);
        modelFunded += rootSum;
        _claims.push(
            ClaimRecord({
                epochId: epochId,
                index: index,
                amount: firstAmount,
                siblingHash: secondLeaf,
                siblingSum: secondAmount,
                claimed: false
            })
        );
    }

    function claim(uint256 seed) external {
        if (_distributor.paused() || _claims.length == 0) return;
        ClaimRecord storage record = _claims[seed % _claims.length];
        if (record.claimed) return;

        (,, uint64 claimStart, uint64 claimEnd,,) = _distributor.epochs(record.epochId);
        if (block.timestamp >= claimEnd) return;
        if (block.timestamp < claimStart) VM.warp(claimStart);

        ToriumRewardDistributor.ProofNode[] memory proof = new ToriumRewardDistributor.ProofNode[](1);
        proof[0] = ToriumRewardDistributor.ProofNode({nodeHash: record.siblingHash, sum: record.siblingSum});
        _distributor.claim(record.epochId, record.index, FIRST_RECIPIENT, record.amount, proof);
        record.claimed = true;
        modelClaimed += record.amount;
    }

    function clawback(uint256 seed) external {
        if (_distributor.paused() || _claims.length == 0) return;
        ClaimRecord storage record = _claims[seed % _claims.length];
        uint256 remaining = _distributor.remainingForEpoch(record.epochId);
        if (remaining == 0) return;

        (,,, uint64 claimEnd,,) = _distributor.epochs(record.epochId);
        uint256 availableAt = uint256(claimEnd) + _distributor.clawbackDelay();
        if (block.timestamp < availableAt) VM.warp(availableAt);
        modelClawed += _distributor.clawback(record.epochId);
    }

    function forceNativeSurplus(uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) + 1;
        VM.deal(address(_distributor), address(_distributor).balance + amount);
        modelForcedSurplus += amount;
    }

    function setPaused(bool shouldPause) external {
        if (shouldPause && !_distributor.paused()) {
            _distributor.pause();
        } else if (!shouldPause && _distributor.paused()) {
            _distributor.unpause();
        }
    }
}

contract ToriumRewardDistributorInvariantTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address payable private constant TREASURY = payable(address(0xD00D));

    ToriumRewardDistributor private _distributor;
    RewardDistributorInvariantHandler private _handler;
    address[] private _targetedContracts;

    function setUp() public {
        _distributor = new ToriumRewardDistributor(
            2 days, address(this), address(this), address(this), address(this), TREASURY, 1 days, 2 days
        );
        _handler = new RewardDistributorInvariantHandler(_distributor);
        _distributor.grantRole(_distributor.EPOCH_PUBLISHER_ROLE(), address(_handler));
        _distributor.grantRole(_distributor.PAUSER_ROLE(), address(_handler));
        _distributor.grantRole(_distributor.CLAWBACK_ROLE(), address(_handler));
        VM.deal(address(_handler), type(uint128).max);
        _targetedContracts.push(address(_handler));
    }

    function targetContracts() public view returns (address[] memory) {
        return _targetedContracts;
    }

    function invariantGlobalAccountingAlwaysReconciles() public view {
        require(_distributor.totalFunded() == _handler.modelFunded(), "funded ghost-model drift");
        require(_distributor.totalClaimed() == _handler.modelClaimed(), "claimed ghost-model drift");
        require(_distributor.totalClawed() == _handler.modelClawed(), "clawed ghost-model drift");
        require(
            _distributor.totalFunded()
                == _distributor.totalClaimed() + _distributor.totalClawed() + _distributor.totalOutstanding(),
            "global accounting drift"
        );
    }

    function invariantNativeBalanceCoversLiabilityAndPreservesSurplus() public view {
        require(address(_distributor).balance >= _distributor.totalOutstanding(), "balance below liability");
        require(_distributor.forcedSurplus() == _handler.modelForcedSurplus(), "forced surplus drift");
    }
}
