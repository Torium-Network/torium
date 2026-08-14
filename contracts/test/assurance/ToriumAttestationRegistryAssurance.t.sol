// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ToriumAttestationRegistry} from "../../src/attestations/ToriumAttestationRegistry.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function getRecordedLogs() external returns (Log[] memory logs);
    function prank(address msgSender) external;
    function recordLogs() external;
    function warp(uint256 newTimestamp) external;
}

contract ToriumAttestationRegistryAssuranceTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ISSUER = address(0x1001);
    address private constant OTHER_ISSUER = address(0x1002);
    bytes32 private constant SCHEMA_ID = keccak256("torium.schema.assurance");
    bytes32 private constant SUBJECT = keccak256("subject:assurance");
    bytes32 private constant REFERENCE_HASH = keccak256("reference:assurance");
    bytes32 private constant CONTENT_HASH = keccak256("content:assurance:v1");
    bytes32 private constant METADATA_HASH = keccak256("metadata:assurance:v1");
    bytes32 private constant METADATA_URI_HASH = keccak256("ipfs://assurance-v1");

    bytes32 private constant ATTESTATION_ISSUED_EVENT =
        keccak256("AttestationIssued(bytes32,address,bytes32,bytes32,bytes32)");
    bytes32 private constant ATTESTATION_SUPERSEDED_EVENT =
        keccak256("AttestationSuperseded(bytes32,bytes32,address,uint64)");
    bytes32 private constant ATTESTATION_REVOKED_EVENT =
        keccak256("AttestationRevoked(bytes32,address,bytes32,uint64)");

    ToriumAttestationRegistry private _registry;

    function setUp() public {
        _registry = new ToriumAttestationRegistry();
        VM.warp(1_750_000_000);
    }

    function testLifecycleEventsExactlyDescribeStoredEdgesAndTimestamps() public {
        bytes32 originalCommitment = _commitment(_registry, CONTENT_HASH, bytes32(0));

        VM.recordLogs();
        bytes32 original = _attest(_registry, ISSUER, CONTENT_HASH, bytes32(0));
        Vm.Log[] memory issueLogs = VM.getRecordedLogs();

        require(issueLogs.length == 1, "unexpected issue log count");
        _assertThreeTopicLog(
            issueLogs[0], address(_registry), ATTESTATION_ISSUED_EVENT, original, _topic(ISSUER), SCHEMA_ID
        );
        (bytes32 loggedCommitment, bytes32 loggedSupersedes) = abi.decode(issueLogs[0].data, (bytes32, bytes32));
        require(loggedCommitment == originalCommitment, "issued commitment event drift");
        require(loggedSupersedes == bytes32(0), "issued predecessor event drift");

        VM.warp(block.timestamp + 1 days);
        bytes32 replacementContent = keccak256("content:assurance:v2");
        bytes32 replacementCommitment = _commitment(_registry, replacementContent, original);
        VM.recordLogs();
        bytes32 replacement = _attest(_registry, ISSUER, replacementContent, original);
        Vm.Log[] memory supersessionLogs = VM.getRecordedLogs();

        require(supersessionLogs.length == 2, "unexpected supersession log count");
        _assertThreeTopicLog(
            supersessionLogs[0], address(_registry), ATTESTATION_SUPERSEDED_EVENT, original, replacement, _topic(ISSUER)
        );
        require(abi.decode(supersessionLogs[0].data, (uint64)) == block.timestamp, "superseded timestamp event drift");
        _assertThreeTopicLog(
            supersessionLogs[1], address(_registry), ATTESTATION_ISSUED_EVENT, replacement, _topic(ISSUER), SCHEMA_ID
        );
        (bytes32 loggedReplacementCommitment, bytes32 loggedOriginal) =
            abi.decode(supersessionLogs[1].data, (bytes32, bytes32));
        require(loggedReplacementCommitment == replacementCommitment, "replacement commitment event drift");
        require(loggedOriginal == original, "replacement predecessor event drift");

        ToriumAttestationRegistry.Attestation memory prior = _registry.getAttestation(original);
        ToriumAttestationRegistry.Attestation memory next = _registry.getAttestation(replacement);
        require(prior.supersededBy == replacement, "event/storage forward-edge drift");
        require(prior.supersededAt == block.timestamp, "event/storage supersession-time drift");
        require(next.supersedes == original, "event/storage backward-edge drift");

        VM.warp(block.timestamp + 1 hours);
        bytes32 reason = keccak256("assurance-revocation");
        VM.recordLogs();
        VM.prank(ISSUER);
        _registry.revoke(replacement, reason);
        Vm.Log[] memory revokeLogs = VM.getRecordedLogs();

        require(revokeLogs.length == 1, "unexpected revoke log count");
        _assertThreeTopicLog(
            revokeLogs[0], address(_registry), ATTESTATION_REVOKED_EVENT, replacement, _topic(ISSUER), reason
        );
        require(abi.decode(revokeLogs[0].data, (uint64)) == block.timestamp, "revoked timestamp event drift");
        ToriumAttestationRegistry.Attestation memory revoked = _registry.getAttestation(replacement);
        require(revoked.revokedAt == block.timestamp, "event/storage revocation-time drift");
        require(revoked.revocationReasonHash == reason, "event/storage revocation-reason drift");
    }

    function testReplayScopeIsPerIssuerPermanentAcrossTerminalStatesAndDomainSeparated() public {
        bytes32 firstIssuerId = _attest(_registry, ISSUER, CONTENT_HASH, bytes32(0));
        bytes32 secondIssuerId = _attest(_registry, OTHER_ISSUER, CONTENT_HASH, bytes32(0));
        require(firstIssuerId != secondIssuerId, "issuer domain did not separate ids");
        require(_registry.issuerNonces(ISSUER) == 1, "first issuer nonce drift");
        require(_registry.issuerNonces(OTHER_ISSUER) == 1, "second issuer nonce drift");

        VM.prank(ISSUER);
        _registry.revoke(firstIssuerId, keccak256("terminal-revocation"));
        uint256 countBeforeReplay = _registry.attestationCount();
        uint256 nonceBeforeReplay = _registry.issuerNonces(ISSUER);
        require(!_tryAttest(_registry, ISSUER, CONTENT_HASH, bytes32(0)), "revoked payload replay succeeded");
        require(_registry.attestationCount() == countBeforeReplay, "failed revoked replay changed count");
        require(_registry.issuerNonces(ISSUER) == nonceBeforeReplay, "failed revoked replay changed nonce");

        bytes32 supersededContent = keccak256("content:terminal-superseded");
        bytes32 superseded = _attest(_registry, ISSUER, supersededContent, bytes32(0));
        _attest(_registry, ISSUER, keccak256("content:replacement"), superseded);
        countBeforeReplay = _registry.attestationCount();
        nonceBeforeReplay = _registry.issuerNonces(ISSUER);
        require(!_tryAttest(_registry, ISSUER, supersededContent, bytes32(0)), "superseded payload replay succeeded");
        require(_registry.attestationCount() == countBeforeReplay, "failed superseded replay changed count");
        require(_registry.issuerNonces(ISSUER) == nonceBeforeReplay, "failed superseded replay changed nonce");

        ToriumAttestationRegistry secondRegistry = new ToriumAttestationRegistry();
        bytes32 secondRegistryId = _attest(secondRegistry, ISSUER, CONTENT_HASH, bytes32(0));
        require(secondRegistryId != firstIssuerId, "registry address domain did not separate ids");
        bytes32 commitment = _commitment(secondRegistry, CONTENT_HASH, bytes32(0));
        require(
            secondRegistryId == secondRegistry.computeAttestationId(ISSUER, 1, commitment),
            "second registry id derivation drift"
        );
    }

    function testInvalidValidationDoesNotConsumeNonceCountOrReplayKey() public {
        bytes32 replayKey = _registry.computeReplayKey(
            ISSUER, SCHEMA_ID, 0, SUBJECT, REFERENCE_HASH, CONTENT_HASH, METADATA_HASH, METADATA_URI_HASH
        );
        VM.prank(ISSUER);
        (bool invalidSucceeded,) = address(_registry)
            .call(
                abi.encodeCall(
                    _registry.attest,
                    (
                        SCHEMA_ID,
                        uint32(0),
                        SUBJECT,
                        REFERENCE_HASH,
                        CONTENT_HASH,
                        METADATA_HASH,
                        METADATA_URI_HASH,
                        bytes32(0)
                    )
                )
            );
        require(!invalidSucceeded, "invalid attestation succeeded");
        require(_registry.attestationCount() == 0, "invalid attestation changed count");
        require(_registry.issuerNonces(ISSUER) == 0, "invalid attestation changed nonce");
        require(!_registry.usedPayloads(replayKey), "invalid attestation burned replay key");

        bytes32 id = _attest(_registry, ISSUER, CONTENT_HASH, bytes32(0));
        require(id != bytes32(0), "valid retry failed after invalid payload");
        require(_registry.issuerNonces(ISSUER) == 1, "valid retry nonce drift");
    }

    function _attest(ToriumAttestationRegistry registry, address issuer, bytes32 contentHash, bytes32 supersedes)
        private
        returns (bytes32)
    {
        VM.prank(issuer);
        return registry.attest(
            SCHEMA_ID, 1, SUBJECT, REFERENCE_HASH, contentHash, METADATA_HASH, METADATA_URI_HASH, supersedes
        );
    }

    function _tryAttest(ToriumAttestationRegistry registry, address issuer, bytes32 contentHash, bytes32 supersedes)
        private
        returns (bool success)
    {
        VM.prank(issuer);
        (success,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.attest,
                    (
                        SCHEMA_ID,
                        uint32(1),
                        SUBJECT,
                        REFERENCE_HASH,
                        contentHash,
                        METADATA_HASH,
                        METADATA_URI_HASH,
                        supersedes
                    )
                )
            );
    }

    function _commitment(ToriumAttestationRegistry registry, bytes32 contentHash, bytes32 supersedes)
        private
        pure
        returns (bytes32)
    {
        return registry.computeCommitment(
            SCHEMA_ID, 1, SUBJECT, REFERENCE_HASH, contentHash, METADATA_HASH, METADATA_URI_HASH, supersedes
        );
    }

    function _assertThreeTopicLog(
        Vm.Log memory log,
        address expectedEmitter,
        bytes32 signature,
        bytes32 first,
        bytes32 second,
        bytes32 third
    ) private pure {
        require(log.emitter == expectedEmitter, "wrong event emitter");
        require(log.topics.length == 4, "wrong indexed topic count");
        require(log.topics[0] == signature, "wrong event signature");
        require(log.topics[1] == first, "wrong first event topic");
        require(log.topics[2] == second, "wrong second event topic");
        require(log.topics[3] == third, "wrong third event topic");
    }

    function _topic(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}

contract AttestationRegistryInvariantHandler {
    struct ModelRecord {
        bytes32 id;
        uint8 status;
        bytes32 supersedes;
        bytes32 supersededBy;
    }

    uint256 private constant MAX_RECORDS = 32;
    bytes32 private constant SCHEMA_ID = keccak256("torium.schema.invariant");
    bytes32 private constant SUBJECT = keccak256("subject:invariant");

    ToriumAttestationRegistry private immutable _registry;
    ModelRecord[] private _records;
    uint256 private _serial;

    constructor(ToriumAttestationRegistry registry_) {
        _registry = registry_;
    }

    function issue(uint256 seed) external {
        if (_records.length >= MAX_RECORDS) return;
        ++_serial;
        bytes32 id = _issue(seed, bytes32(0));
        _records.push(ModelRecord({id: id, status: 1, supersedes: bytes32(0), supersededBy: bytes32(0)}));
    }

    function supersede(uint256 seed) external {
        if (_records.length == 0 || _records.length >= MAX_RECORDS) return;
        uint256 priorIndex = seed % _records.length;
        ModelRecord storage prior = _records[priorIndex];
        if (prior.status != 1) return;

        ++_serial;
        bytes32 replacement = _issue(seed, prior.id);
        prior.status = 2;
        prior.supersededBy = replacement;
        _records.push(ModelRecord({id: replacement, status: 1, supersedes: prior.id, supersededBy: bytes32(0)}));
    }

    function revoke(uint256 seed) external {
        if (_records.length == 0) return;
        ModelRecord storage record = _records[seed % _records.length];
        if (record.status != 1) return;
        bytes32 reason = keccak256(abi.encode("invariant-revocation", seed, record.id));
        _registry.revoke(record.id, reason);
        record.status = 3;
    }

    function replayMustFail(uint256 seed) external {
        if (_records.length == 0) return;
        ModelRecord storage record = _records[seed % _records.length];
        ToriumAttestationRegistry.Attestation memory existing = _registry.getAttestation(record.id);
        uint256 countBefore = _registry.attestationCount();
        uint256 nonceBefore = _registry.issuerNonces(address(this));
        (bool success,) = address(_registry)
            .call(
                abi.encodeCall(
                    _registry.attest,
                    (
                        existing.schemaId,
                        existing.schemaVersion,
                        existing.subject,
                        existing.referenceHash,
                        existing.contentHash,
                        existing.metadataHash,
                        existing.metadataUriHash,
                        bytes32(0)
                    )
                )
            );
        require(!success, "stateful replay succeeded");
        require(_registry.attestationCount() == countBefore, "stateful replay changed count");
        require(_registry.issuerNonces(address(this)) == nonceBefore, "stateful replay changed nonce");
    }

    function recordCount() external view returns (uint256) {
        return _records.length;
    }

    function recordAt(uint256 index)
        external
        view
        returns (bytes32 id, uint8 status, bytes32 supersedes, bytes32 supersededBy)
    {
        ModelRecord storage record = _records[index];
        return (record.id, record.status, record.supersedes, record.supersededBy);
    }

    function _issue(uint256 seed, bytes32 supersedes) private returns (bytes32) {
        bytes32 referenceHash = keccak256(abi.encode("reference", _serial, seed));
        bytes32 contentHash = keccak256(abi.encode("content", _serial, seed));
        bytes32 metadataHash = keccak256(abi.encode("metadata", _serial, seed));
        bytes32 metadataUriHash = keccak256(abi.encode("metadata-uri", _serial, seed));
        return
            _registry.attest(
                SCHEMA_ID, 1, SUBJECT, referenceHash, contentHash, metadataHash, metadataUriHash, supersedes
            );
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
contract ToriumAttestationRegistryInvariantTest {
    ToriumAttestationRegistry private _registry;
    AttestationRegistryInvariantHandler private _handler;
    address[] private _targetedContracts;

    function setUp() public {
        _registry = new ToriumAttestationRegistry();
        _handler = new AttestationRegistryInvariantHandler(_registry);
        _targetedContracts.push(address(_handler));
    }

    function targetContracts() public view returns (address[] memory) {
        return _targetedContracts;
    }

    function invariantModelMatchesRegistryStateAndLinks() public view {
        uint256 count = _handler.recordCount();
        require(_registry.attestationCount() == count, "attestation count/model drift");
        require(_registry.issuerNonces(address(_handler)) == count, "issuer nonce/model drift");

        for (uint256 i = 0; i < count; ++i) {
            (bytes32 id, uint8 modelStatus, bytes32 modelSupersedes, bytes32 modelSupersededBy) = _handler.recordAt(i);
            ToriumAttestationRegistry.Attestation memory record = _registry.getAttestation(id);
            require(record.issuer == address(_handler), "stateful issuer drift");
            require(record.issuerNonce == i + 1, "stateful nonce sequence drift");
            require(record.supersedes == modelSupersedes, "stateful backward-edge drift");
            require(record.supersededBy == modelSupersededBy, "stateful forward-edge drift");
            require(uint8(_registry.statusOf(id)) == modelStatus, "stateful status drift");
            require(_registry.isActive(id) == (modelStatus == 1), "stateful active query drift");
        }
    }
}
