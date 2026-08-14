// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ToriumRewardDistributor} from "../../src/rewards/ToriumRewardDistributor.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function deal(address account, uint256 newBalance) external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function prank(address msgSender) external;
    function recordLogs() external;
    function warp(uint256 newTimestamp) external;
}

contract ToriumRewardDistributorAssuranceTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xA11CE);
    address private constant PUBLISHER = address(0xB0B);
    address private constant REPLACEMENT_PUBLISHER = address(0xB0B2);
    address private constant PAUSER = address(0xCAFE);
    address private constant REPLACEMENT_PAUSER = address(0xCAFE2);
    address private constant CLAWBACK_OPERATOR = address(0xC1A0);
    address private constant REPLACEMENT_CLAWBACK = address(0xC1A02);
    address private constant TREASURY = address(0x7EAA);
    address payable private constant ALICE = payable(address(0xA11));
    address payable private constant BOB = payable(address(0xB22));
    address payable private constant CAROL = payable(address(0xC33));
    address payable private constant DAVE = payable(address(0xD44));

    uint64 private constant PUBLICATION_DELAY = 1 days;
    uint64 private constant CLAWBACK_DELAY = 2 days;

    bytes32 private constant EPOCH_PUBLISHED_EVENT =
        keccak256("EpochPublished(uint256,bytes32,address,uint256,uint64,uint64)");
    bytes32 private constant REWARD_CLAIMED_EVENT =
        keccak256("RewardClaimed(uint256,uint256,address,uint256,uint256,uint256)");
    bytes32 private constant EPOCH_CLAWED_BACK_EVENT =
        keccak256("EpochClawedBack(uint256,address,address,uint256,uint256,uint256)");
    bytes32 private constant ACCOUNTING_RECONCILED_EVENT =
        keccak256("AccountingReconciled(uint256,uint256,uint256,uint256,uint256)");

    ToriumRewardDistributor private _distributor;

    function setUp() public {
        _distributor = new ToriumRewardDistributor(
            1 days, ADMIN, PUBLISHER, PAUSER, CLAWBACK_OPERATOR, payable(TREASURY), PUBLICATION_DELAY, CLAWBACK_DELAY
        );
        VM.deal(PUBLISHER, 100 ether);
        VM.deal(REPLACEMENT_PUBLISHER, 100 ether);
    }

    function testLifecycleEventsExactlyReconcileLiabilities() public {
        uint256 amount = 3 ether;
        bytes32 root = _distributor.leafHash(1, 0, ALICE, amount);
        uint64 start = uint64(block.timestamp + PUBLICATION_DELAY);
        uint64 end = start + 3 days;

        VM.recordLogs();
        _publish(PUBLISHER, 1, root, amount, start, end);
        Vm.Log[] memory publishLogs = VM.getRecordedLogs();

        require(publishLogs.length == 2, "unexpected publish log count");
        _assertThreeTopicLog(publishLogs[0], EPOCH_PUBLISHED_EVENT, bytes32(uint256(1)), root, _topic(PUBLISHER));
        (uint256 publishedAmount, uint64 publishedStart, uint64 publishedEnd) =
            abi.decode(publishLogs[0].data, (uint256, uint64, uint64));
        require(publishedAmount == amount, "published amount event drift");
        require(publishedStart == start && publishedEnd == end, "published window event drift");
        _assertAccountingLog(publishLogs[1], 1, amount, amount, amount, 0);

        VM.warp(start);
        ToriumRewardDistributor.ProofNode[] memory emptyProof = new ToriumRewardDistributor.ProofNode[](0);
        VM.recordLogs();
        _distributor.claim(1, 0, ALICE, amount, emptyProof);
        Vm.Log[] memory claimLogs = VM.getRecordedLogs();

        require(claimLogs.length == 2, "unexpected claim log count");
        _assertThreeTopicLog(
            claimLogs[0], REWARD_CLAIMED_EVENT, bytes32(uint256(1)), bytes32(uint256(0)), _topic(ALICE)
        );
        (uint256 claimedAmount, uint256 epochClaimed, uint256 totalClaimed) =
            abi.decode(claimLogs[0].data, (uint256, uint256, uint256));
        require(claimedAmount == amount, "claim amount event drift");
        require(epochClaimed == amount && totalClaimed == amount, "claim accounting event drift");
        _assertAccountingLog(claimLogs[1], 1, 0, 0, 0, 0);

        uint256 clawAmount = 2 ether;
        bytes32 clawRoot = _distributor.leafHash(2, 0, BOB, clawAmount);
        uint64 clawStart = uint64(block.timestamp + PUBLICATION_DELAY);
        uint64 clawEnd = clawStart + 1 days;
        _publish(PUBLISHER, 2, clawRoot, clawAmount, clawStart, clawEnd);
        VM.warp(uint256(clawEnd) + CLAWBACK_DELAY);

        uint256 treasuryBefore = TREASURY.balance;
        VM.recordLogs();
        VM.prank(CLAWBACK_OPERATOR);
        uint256 clawed = _distributor.clawback(2);
        Vm.Log[] memory clawLogs = VM.getRecordedLogs();

        require(clawed == clawAmount, "clawback return drift");
        require(TREASURY.balance == treasuryBefore + clawAmount, "treasury receipt drift");
        require(clawLogs.length == 2, "unexpected clawback log count");
        _assertThreeTopicLog(
            clawLogs[0], EPOCH_CLAWED_BACK_EVENT, bytes32(uint256(2)), _topic(CLAWBACK_OPERATOR), _topic(TREASURY)
        );
        (uint256 loggedClaw, uint256 epochClawed, uint256 totalClawed) =
            abi.decode(clawLogs[0].data, (uint256, uint256, uint256));
        require(loggedClaw == clawAmount, "clawback amount event drift");
        require(epochClawed == clawAmount && totalClawed == clawAmount, "clawback accounting event drift");
        _assertAccountingLog(clawLogs[1], 2, 0, 0, 0, 0);
    }

    function testOperationalRolesCanBeLostAndRecoveredByAdmin() public {
        bytes32 publisherRole = _distributor.EPOCH_PUBLISHER_ROLE();
        bytes32 pauserRole = _distributor.PAUSER_ROLE();
        bytes32 clawbackRole = _distributor.CLAWBACK_ROLE();

        VM.prank(ADMIN);
        _distributor.revokeRole(publisherRole, PUBLISHER);
        (bytes32 firstRoot, uint256 firstAmount, uint64 firstStart, uint64 firstEnd) =
            _singleLeafEpoch(1, ALICE, 1 ether);
        require(
            !_tryPublish(PUBLISHER, 1, firstRoot, firstAmount, firstStart, firstEnd),
            "revoked publisher still published"
        );
        VM.prank(ADMIN);
        _distributor.grantRole(publisherRole, REPLACEMENT_PUBLISHER);
        _publish(REPLACEMENT_PUBLISHER, 1, firstRoot, firstAmount, firstStart, firstEnd);

        VM.prank(PAUSER);
        _distributor.pause();
        VM.prank(PAUSER);
        _distributor.renounceRole(pauserRole, PAUSER);
        VM.prank(PAUSER);
        (bool oldPauserSucceeded,) = address(_distributor).call(abi.encodeCall(_distributor.unpause, ()));
        require(!oldPauserSucceeded, "renounced pauser still unpaused");
        VM.prank(ADMIN);
        _distributor.grantRole(pauserRole, REPLACEMENT_PAUSER);
        VM.prank(REPLACEMENT_PAUSER);
        _distributor.unpause();

        VM.prank(CLAWBACK_OPERATOR);
        _distributor.renounceRole(clawbackRole, CLAWBACK_OPERATOR);
        VM.warp(uint256(firstEnd) + CLAWBACK_DELAY);
        VM.prank(CLAWBACK_OPERATOR);
        (bool oldClawbackSucceeded,) = address(_distributor).call(abi.encodeCall(_distributor.clawback, (1)));
        require(!oldClawbackSucceeded, "renounced clawback operator still clawed back");
        VM.prank(ADMIN);
        _distributor.grantRole(clawbackRole, REPLACEMENT_CLAWBACK);
        VM.prank(REPLACEMENT_CLAWBACK);
        require(_distributor.clawback(1) == firstAmount, "replacement clawback operator failed");
    }

    function testDeepMerkleProofCannotReplayAcrossEpochDomain() public {
        (bytes32 root1, ToriumRewardDistributor.ProofNode[] memory proof1) = _fourLeafRootAndFirstProof(1);
        uint64 start1 = uint64(block.timestamp + PUBLICATION_DELAY);
        uint64 end1 = start1 + 3 days;
        _publish(PUBLISHER, 1, root1, 10 ether, start1, end1);
        VM.warp(start1);
        _distributor.claim(1, 0, ALICE, 1 ether, proof1);

        (bytes32 root2, ToriumRewardDistributor.ProofNode[] memory proof2) = _fourLeafRootAndFirstProof(2);
        uint64 start2 = uint64(block.timestamp + PUBLICATION_DELAY);
        uint64 end2 = start2 + 3 days;
        _publish(PUBLISHER, 2, root2, 10 ether, start2, end2);
        VM.warp(start2);

        (bool replaySucceeded,) =
            address(_distributor).call(abi.encodeCall(_distributor.claim, (2, 0, ALICE, 1 ether, proof1)));
        require(!replaySucceeded, "cross-epoch proof replay succeeded");
        require(!_distributor.isClaimed(2, 0), "failed replay consumed claim bit");
        require(_distributor.remainingForEpoch(2) == 10 ether, "failed replay changed liability");

        _distributor.claim(2, 0, ALICE, 1 ether, proof2);
        require(_distributor.isClaimed(2, 0), "valid deep proof did not claim");
        require(_distributor.remainingForEpoch(2) == 9 ether, "valid deep proof accounting drift");
    }

    function testGasRewardPublish() public {
        (bytes32 root, uint256 amount, uint64 start, uint64 end) = _singleLeafEpoch(1, ALICE, 1 ether);
        _publish(PUBLISHER, 1, root, amount, start, end);
    }

    function testGasRewardClaim() public {
        (bytes32 root, uint256 amount, uint64 start, uint64 end) = _singleLeafEpoch(1, ALICE, 1 ether);
        _publish(PUBLISHER, 1, root, amount, start, end);
        VM.warp(start);
        ToriumRewardDistributor.ProofNode[] memory proof = new ToriumRewardDistributor.ProofNode[](0);
        _distributor.claim(1, 0, ALICE, amount, proof);
    }

    function testGasRewardClawback() public {
        (bytes32 root, uint256 amount, uint64 start, uint64 end) = _singleLeafEpoch(1, ALICE, 1 ether);
        _publish(PUBLISHER, 1, root, amount, start, end);
        VM.warp(uint256(end) + CLAWBACK_DELAY);
        VM.prank(CLAWBACK_OPERATOR);
        _distributor.clawback(1);
    }

    function _singleLeafEpoch(uint256 epochId, address account, uint256 amount)
        private
        view
        returns (bytes32 root, uint256 rootSum, uint64 start, uint64 end)
    {
        root = _distributor.leafHash(epochId, 0, account, amount);
        rootSum = amount;
        start = uint64(block.timestamp + PUBLICATION_DELAY);
        end = start + 3 days;
    }

    function _fourLeafRootAndFirstProof(uint256 epochId)
        private
        view
        returns (bytes32 root, ToriumRewardDistributor.ProofNode[] memory proof)
    {
        uint256[4] memory amounts = [uint256(1 ether), 2 ether, 3 ether, 4 ether];
        address payable[4] memory accounts = [ALICE, BOB, CAROL, DAVE];
        bytes32[4] memory leaves;
        for (uint256 i = 0; i < 4; ++i) {
            leaves[i] = _distributor.leafHash(epochId, i, accounts[i], amounts[i]);
        }
        (bytes32 leftHash, uint256 leftSum) = _distributor.hashNode(leaves[0], amounts[0], leaves[1], amounts[1]);
        (bytes32 rightHash, uint256 rightSum) = _distributor.hashNode(leaves[2], amounts[2], leaves[3], amounts[3]);
        (root,) = _distributor.hashNode(leftHash, leftSum, rightHash, rightSum);

        proof = new ToriumRewardDistributor.ProofNode[](2);
        proof[0] = ToriumRewardDistributor.ProofNode({nodeHash: leaves[1], sum: amounts[1]});
        proof[1] = ToriumRewardDistributor.ProofNode({nodeHash: rightHash, sum: rightSum});
    }

    function _publish(address publisher, uint256 epochId, bytes32 root, uint256 amount, uint64 start, uint64 end)
        private
    {
        VM.prank(publisher);
        _distributor.publishEpoch{value: amount}(epochId, root, amount, start, end);
    }

    function _tryPublish(address publisher, uint256 epochId, bytes32 root, uint256 amount, uint64 start, uint64 end)
        private
        returns (bool success)
    {
        VM.prank(publisher);
        (success,) = address(_distributor).call{value: amount}(
            abi.encodeCall(_distributor.publishEpoch, (epochId, root, amount, start, end))
        );
    }

    function _assertThreeTopicLog(Vm.Log memory log, bytes32 signature, bytes32 first, bytes32 second, bytes32 third)
        private
        view
    {
        require(log.emitter == address(_distributor), "wrong event emitter");
        require(log.topics.length == 4, "wrong indexed topic count");
        require(log.topics[0] == signature, "wrong event signature");
        require(log.topics[1] == first, "wrong first event topic");
        require(log.topics[2] == second, "wrong second event topic");
        require(log.topics[3] == third, "wrong third event topic");
    }

    function _assertAccountingLog(
        Vm.Log memory log,
        uint256 epochId,
        uint256 epochOutstanding,
        uint256 totalOutstanding,
        uint256 nativeBalance,
        uint256 forcedSurplus
    ) private view {
        require(log.emitter == address(_distributor), "wrong accounting emitter");
        require(log.topics.length == 2, "wrong accounting topic count");
        require(log.topics[0] == ACCOUNTING_RECONCILED_EVENT, "wrong accounting signature");
        require(log.topics[1] == bytes32(epochId), "wrong accounting epoch topic");
        (uint256 loggedEpochOutstanding, uint256 loggedTotalOutstanding, uint256 loggedBalance, uint256 loggedSurplus) =
            abi.decode(log.data, (uint256, uint256, uint256, uint256));
        require(loggedEpochOutstanding == epochOutstanding, "epoch outstanding event drift");
        require(loggedTotalOutstanding == totalOutstanding, "total outstanding event drift");
        require(loggedBalance == nativeBalance, "native balance event drift");
        require(loggedSurplus == forcedSurplus, "forced surplus event drift");
    }

    function _topic(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}
