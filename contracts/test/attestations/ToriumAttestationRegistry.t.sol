// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ToriumAttestationRegistry} from "../../src/attestations/ToriumAttestationRegistry.sol";

interface Vm {
    function expectPartialRevert(bytes4 revertData) external;
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
}

contract ToriumAttestationRegistryTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ISSUER = address(0x1001);
    address private constant OTHER_ISSUER = address(0x1002);
    bytes32 private constant SCHEMA_ID = keccak256("torium.schema.identity");
    bytes32 private constant OTHER_SCHEMA_ID = keccak256("torium.schema.other");
    bytes32 private constant SUBJECT = keccak256("subject:alice");
    bytes32 private constant OTHER_SUBJECT = keccak256("subject:bob");
    bytes32 private constant REFERENCE = keccak256("reference:source-record");
    bytes32 private constant CONTENT_HASH = keccak256("content:v1");
    bytes32 private constant METADATA_HASH = keccak256("metadata:v1");
    bytes32 private constant METADATA_URI_HASH = keccak256("ipfs://metadata-v1");

    ToriumAttestationRegistry private _registry;

    function setUp() public {
        _registry = new ToriumAttestationRegistry();
        VM.warp(1_750_000_000);
    }

    function testCreateAndQueryExactCommitment() public {
        bytes32 commitment = _registry.computeCommitment(
            SCHEMA_ID, 1, SUBJECT, REFERENCE, CONTENT_HASH, METADATA_HASH, METADATA_URI_HASH, bytes32(0)
        );
        bytes32 expectedId = _registry.computeAttestationId(ISSUER, 1, commitment);

        bytes32 attestationId = _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, REFERENCE, CONTENT_HASH, bytes32(0));
        require(attestationId == expectedId, "attestation id mismatch");

        ToriumAttestationRegistry.Attestation memory record = _registry.getAttestation(attestationId);
        require(record.schemaId == SCHEMA_ID, "schema mismatch");
        require(record.schemaVersion == 1, "schema version mismatch");
        require(record.issuer == ISSUER, "issuer mismatch");
        require(record.issuerNonce == 1, "issuer nonce mismatch");
        require(record.subject == SUBJECT, "subject mismatch");
        require(record.referenceHash == REFERENCE, "reference mismatch");
        require(record.contentHash == CONTENT_HASH, "content mismatch");
        require(record.metadataHash == METADATA_HASH, "metadata mismatch");
        require(record.metadataUriHash == METADATA_URI_HASH, "metadata uri mismatch");
        require(record.supersedes == bytes32(0), "unexpected predecessor");
        require(record.supersededBy == bytes32(0), "unexpected replacement");
        require(record.createdAt == block.timestamp, "created timestamp mismatch");
        require(record.revokedAt == 0 && record.supersededAt == 0, "terminal timestamp set");
        require(record.revocationReasonHash == bytes32(0), "revocation reason set");

        require(_registry.attestationCount() == 1, "count mismatch");
        require(_registry.issuerNonces(ISSUER) == 1, "nonce counter mismatch");
        require(_registry.statusOf(attestationId) == ToriumAttestationRegistry.Status.Active, "not active");
        require(_registry.isActive(attestationId), "active query false");
        require(_registry.commitmentOf(attestationId) == commitment, "commitment query mismatch");
        require(_registry.verify(attestationId, ISSUER, commitment), "verify false");
        require(!_registry.verify(attestationId, OTHER_ISSUER, commitment), "wrong issuer verified");

        bytes32 replayKey = _registry.computeReplayKey(
            ISSUER, SCHEMA_ID, 1, SUBJECT, REFERENCE, CONTENT_HASH, METADATA_HASH, METADATA_URI_HASH
        );
        require(_registry.usedPayloads(replayKey), "replay key missing");
    }

    function testSupersessionIsExclusiveAndAllowsVersionChange() public {
        bytes32 original = _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, bytes32(0), CONTENT_HASH, bytes32(0));
        VM.warp(block.timestamp + 1 days);
        bytes32 replacementContent = keccak256("content:v2");
        bytes32 replacement = _attest(ISSUER, SCHEMA_ID, 9, SUBJECT, REFERENCE, replacementContent, original);

        ToriumAttestationRegistry.Attestation memory prior = _registry.getAttestation(original);
        ToriumAttestationRegistry.Attestation memory next = _registry.getAttestation(replacement);
        require(prior.supersededBy == replacement, "forward link mismatch");
        require(prior.supersededAt == block.timestamp, "superseded timestamp mismatch");
        require(next.supersedes == original, "backward link mismatch");
        require(next.schemaVersion == 9, "version change rejected");
        require(_registry.statusOf(original) == ToriumAttestationRegistry.Status.Superseded, "prior not superseded");
        require(_registry.statusOf(replacement) == ToriumAttestationRegistry.Status.Active, "replacement inactive");
        require(!_registry.isActive(original), "superseded record active");

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.InvalidAttestationStatus.selector);
        _registry.attest(
            SCHEMA_ID, 10, SUBJECT, bytes32(0), keccak256("content:v3"), METADATA_HASH, METADATA_URI_HASH, original
        );
    }

    function testSupersessionRejectsMissingIssuerSchemaAndSubjectMismatch() public {
        bytes32 original = _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, bytes32(0), CONTENT_HASH, bytes32(0));

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.AttestationNotFound.selector);
        _registry.attest(
            SCHEMA_ID,
            2,
            SUBJECT,
            bytes32(0),
            keccak256("missing-prior"),
            METADATA_HASH,
            METADATA_URI_HASH,
            keccak256("missing")
        );

        VM.prank(OTHER_ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.IssuerMismatch.selector);
        _registry.attest(
            SCHEMA_ID, 2, SUBJECT, bytes32(0), keccak256("wrong-issuer"), METADATA_HASH, METADATA_URI_HASH, original
        );

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.SchemaMismatch.selector);
        _registry.attest(
            OTHER_SCHEMA_ID,
            2,
            SUBJECT,
            bytes32(0),
            keccak256("wrong-schema"),
            METADATA_HASH,
            METADATA_URI_HASH,
            original
        );

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.SubjectMismatch.selector);
        _registry.attest(
            SCHEMA_ID,
            2,
            OTHER_SUBJECT,
            bytes32(0),
            keccak256("wrong-subject"),
            METADATA_HASH,
            METADATA_URI_HASH,
            original
        );
    }

    function testRevokeRequiresActiveIssuerAndNonzeroReason() public {
        bytes32 attestationId = _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, bytes32(0), CONTENT_HASH, bytes32(0));

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.ZeroRevocationReasonHash.selector);
        _registry.revoke(attestationId, bytes32(0));

        VM.prank(OTHER_ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.IssuerMismatch.selector);
        _registry.revoke(attestationId, keccak256("unauthorized"));

        bytes32 reason = keccak256("issuer-requested-revocation");
        VM.warp(block.timestamp + 1 hours);
        VM.prank(ISSUER);
        _registry.revoke(attestationId, reason);

        ToriumAttestationRegistry.Attestation memory record = _registry.getAttestation(attestationId);
        require(record.revocationReasonHash == reason, "reason mismatch");
        require(record.revokedAt == block.timestamp, "revoked timestamp mismatch");
        require(_registry.statusOf(attestationId) == ToriumAttestationRegistry.Status.Revoked, "not revoked");
        require(!_registry.isActive(attestationId), "revoked record active");

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.InvalidAttestationStatus.selector);
        _registry.revoke(attestationId, keccak256("again"));
    }

    function testInvalidPayloadAndPermanentReplayFailClosed() public {
        _expectInvalidPayload(
            ToriumAttestationRegistry.ZeroSchemaId.selector,
            bytes32(0),
            1,
            SUBJECT,
            CONTENT_HASH,
            METADATA_HASH,
            METADATA_URI_HASH
        );
        _expectInvalidPayload(
            ToriumAttestationRegistry.ZeroSchemaVersion.selector,
            SCHEMA_ID,
            0,
            SUBJECT,
            CONTENT_HASH,
            METADATA_HASH,
            METADATA_URI_HASH
        );
        _expectInvalidPayload(
            ToriumAttestationRegistry.ZeroSubject.selector,
            SCHEMA_ID,
            1,
            bytes32(0),
            CONTENT_HASH,
            METADATA_HASH,
            METADATA_URI_HASH
        );
        _expectInvalidPayload(
            ToriumAttestationRegistry.ZeroContentHash.selector,
            SCHEMA_ID,
            1,
            SUBJECT,
            bytes32(0),
            METADATA_HASH,
            METADATA_URI_HASH
        );
        _expectInvalidPayload(
            ToriumAttestationRegistry.ZeroMetadataHash.selector,
            SCHEMA_ID,
            1,
            SUBJECT,
            CONTENT_HASH,
            bytes32(0),
            METADATA_URI_HASH
        );
        _expectInvalidPayload(
            ToriumAttestationRegistry.ZeroMetadataUriHash.selector,
            SCHEMA_ID,
            1,
            SUBJECT,
            CONTENT_HASH,
            METADATA_HASH,
            bytes32(0)
        );

        _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, REFERENCE, CONTENT_HASH, bytes32(0));
        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.DuplicatePayload.selector);
        _registry.attest(
            SCHEMA_ID,
            1,
            SUBJECT,
            REFERENCE,
            CONTENT_HASH,
            METADATA_HASH,
            METADATA_URI_HASH,
            keccak256("different-supersedes-does-not-bypass-replay")
        );
    }

    function testMissingQueriesFailOrReturnFalseWithoutAmbiguity() public {
        bytes32 missing = keccak256("missing-attestation");
        require(_registry.statusOf(missing) == ToriumAttestationRegistry.Status.Missing, "not missing");
        require(!_registry.isActive(missing), "missing active");
        require(!_registry.verify(missing, ISSUER, keccak256("commitment")), "missing verified");

        VM.expectPartialRevert(ToriumAttestationRegistry.AttestationNotFound.selector);
        _registry.commitmentOf(missing);
        VM.expectPartialRevert(ToriumAttestationRegistry.AttestationNotFound.selector);
        _registry.getAttestation(missing);
    }

    function testFuzzDeterministicIdAndReplay(uint32 rawVersion, bytes32 referenceHash, bytes32 rawContent) public {
        uint32 schemaVersion = rawVersion == 0 ? 1 : rawVersion;
        bytes32 contentHash = _nonzero(rawContent);
        bytes32 commitment = _registry.computeCommitment(
            SCHEMA_ID, schemaVersion, SUBJECT, referenceHash, contentHash, METADATA_HASH, METADATA_URI_HASH, bytes32(0)
        );
        bytes32 expectedId = _registry.computeAttestationId(ISSUER, 1, commitment);

        VM.prank(ISSUER);
        bytes32 actualId = _registry.attest(
            SCHEMA_ID, schemaVersion, SUBJECT, referenceHash, contentHash, METADATA_HASH, METADATA_URI_HASH, bytes32(0)
        );
        require(actualId == expectedId, "fuzz id mismatch");
        require(_registry.verify(actualId, ISSUER, commitment), "fuzz verify false");

        VM.prank(ISSUER);
        VM.expectPartialRevert(ToriumAttestationRegistry.DuplicatePayload.selector);
        _registry.attest(
            SCHEMA_ID,
            schemaVersion,
            SUBJECT,
            referenceHash,
            contentHash,
            METADATA_HASH,
            METADATA_URI_HASH,
            keccak256("alternate-edge")
        );
    }

    /// @dev Stable entry points for focused `forge snapshot` gas evidence.
    function testGasAttest() public {
        _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, bytes32(0), CONTENT_HASH, bytes32(0));
    }

    function testGasSupersede() public {
        bytes32 original = _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, bytes32(0), CONTENT_HASH, bytes32(0));
        _attest(ISSUER, SCHEMA_ID, 2, SUBJECT, REFERENCE, keccak256("gas-content-v2"), original);
    }

    function testGasRevoke() public {
        bytes32 attestationId = _attest(ISSUER, SCHEMA_ID, 1, SUBJECT, bytes32(0), CONTENT_HASH, bytes32(0));
        VM.prank(ISSUER);
        _registry.revoke(attestationId, keccak256("gas-revocation"));
    }

    function _attest(
        address issuer,
        bytes32 schemaId,
        uint32 schemaVersion,
        bytes32 subject,
        bytes32 referenceHash,
        bytes32 contentHash,
        bytes32 supersedes
    ) private returns (bytes32) {
        VM.prank(issuer);
        return _registry.attest(
            schemaId, schemaVersion, subject, referenceHash, contentHash, METADATA_HASH, METADATA_URI_HASH, supersedes
        );
    }

    function _expectInvalidPayload(
        bytes4 selector,
        bytes32 schemaId,
        uint32 schemaVersion,
        bytes32 subject,
        bytes32 contentHash,
        bytes32 metadataHash,
        bytes32 metadataUriHash
    ) private {
        VM.prank(ISSUER);
        VM.expectPartialRevert(selector);
        _registry.attest(
            schemaId, schemaVersion, subject, bytes32(0), contentHash, metadataHash, metadataUriHash, bytes32(0)
        );
    }

    function _nonzero(bytes32 value) private pure returns (bytes32) {
        return value == bytes32(0) ? bytes32(uint256(1)) : value;
    }
}
