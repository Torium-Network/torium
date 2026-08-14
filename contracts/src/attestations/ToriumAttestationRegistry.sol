// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @title Torium hash-only attestation registry
/// @notice Records issuer-owned commitments without administrators, allowlists, or backend trust.
/// @dev The caller is always the issuer. Payload bytes and metadata remain off-chain.
contract ToriumAttestationRegistry {
    enum Status {
        Missing,
        Active,
        Superseded,
        Revoked
    }

    struct Attestation {
        bytes32 schemaId;
        uint32 schemaVersion;
        address issuer;
        uint256 issuerNonce;
        bytes32 subject;
        bytes32 referenceHash;
        bytes32 contentHash;
        bytes32 metadataHash;
        bytes32 metadataUriHash;
        bytes32 supersedes;
        bytes32 supersededBy;
        uint64 createdAt;
        uint64 revokedAt;
        uint64 supersededAt;
        bytes32 revocationReasonHash;
    }

    error ZeroSchemaId();
    error ZeroSchemaVersion();
    error ZeroSubject();
    error ZeroContentHash();
    error ZeroMetadataHash();
    error ZeroMetadataUriHash();
    error ZeroRevocationReasonHash();
    error AttestationNotFound(bytes32 attestationId);
    error DuplicatePayload(bytes32 replayKey);
    error AttestationIdCollision(bytes32 attestationId);
    error InvalidAttestationStatus(bytes32 attestationId, Status actualStatus);
    error IssuerMismatch(address expectedIssuer, address actualIssuer);
    error SchemaMismatch(bytes32 expectedSchemaId, bytes32 actualSchemaId);
    error SubjectMismatch(bytes32 expectedSubject, bytes32 actualSubject);
    error TimestampOverflow(uint256 timestamp);

    event AttestationIssued(
        bytes32 indexed attestationId,
        address indexed issuer,
        bytes32 indexed schemaId,
        bytes32 commitment,
        bytes32 supersedes
    );
    event AttestationSuperseded(
        bytes32 indexed supersededAttestationId,
        bytes32 indexed replacementAttestationId,
        address indexed issuer,
        uint64 supersededAt
    );
    event AttestationRevoked(
        bytes32 indexed attestationId, address indexed issuer, bytes32 indexed revocationReasonHash, uint64 revokedAt
    );

    uint256 public attestationCount;

    mapping(address issuer => uint256 latestNonce) public issuerNonces;
    mapping(bytes32 attestationId => Attestation attestation) private _attestations;
    mapping(bytes32 replayKey => bool used) public usedPayloads;

    /// @notice Creates an immutable commitment, optionally superseding one active prior record.
    function attest(
        bytes32 schemaId,
        uint32 schemaVersion,
        bytes32 subject,
        bytes32 referenceHash,
        bytes32 contentHash,
        bytes32 metadataHash,
        bytes32 metadataUriHash,
        bytes32 supersedes
    ) external returns (bytes32 attestationId) {
        _validatePayload(schemaId, schemaVersion, subject, contentHash, metadataHash, metadataUriHash);

        address issuer = msg.sender;
        bytes32 replayKey = computeReplayKey(
            issuer, schemaId, schemaVersion, subject, referenceHash, contentHash, metadataHash, metadataUriHash
        );
        if (usedPayloads[replayKey]) revert DuplicatePayload(replayKey);

        if (supersedes != bytes32(0)) {
            Attestation storage prior = _requireAttestation(supersedes);
            Status priorStatus = _status(prior);
            if (priorStatus != Status.Active) {
                revert InvalidAttestationStatus(supersedes, priorStatus);
            }
            if (prior.issuer != issuer) revert IssuerMismatch(prior.issuer, issuer);
            if (prior.schemaId != schemaId) {
                revert SchemaMismatch(prior.schemaId, schemaId);
            }
            if (prior.subject != subject) revert SubjectMismatch(prior.subject, subject);
        }

        uint256 issuerNonce = issuerNonces[issuer] + 1;
        bytes32 commitment = computeCommitment(
            schemaId, schemaVersion, subject, referenceHash, contentHash, metadataHash, metadataUriHash, supersedes
        );
        attestationId = computeAttestationId(issuer, issuerNonce, commitment);
        if (attestationId == bytes32(0) || _attestations[attestationId].issuer != address(0)) {
            revert AttestationIdCollision(attestationId);
        }

        uint64 timestamp = _timestamp();
        _attestations[attestationId] = Attestation({
            schemaId: schemaId,
            schemaVersion: schemaVersion,
            issuer: issuer,
            issuerNonce: issuerNonce,
            subject: subject,
            referenceHash: referenceHash,
            contentHash: contentHash,
            metadataHash: metadataHash,
            metadataUriHash: metadataUriHash,
            supersedes: supersedes,
            supersededBy: bytes32(0),
            createdAt: timestamp,
            revokedAt: 0,
            supersededAt: 0,
            revocationReasonHash: bytes32(0)
        });
        issuerNonces[issuer] = issuerNonce;
        usedPayloads[replayKey] = true;
        ++attestationCount;

        if (supersedes != bytes32(0)) {
            Attestation storage prior = _attestations[supersedes];
            prior.supersededBy = attestationId;
            prior.supersededAt = timestamp;
            emit AttestationSuperseded(supersedes, attestationId, issuer, timestamp);
        }

        emit AttestationIssued(attestationId, issuer, schemaId, commitment, supersedes);
    }

    /// @notice Permanently revokes one active attestation owned by the caller.
    function revoke(bytes32 attestationId, bytes32 revocationReasonHash) external {
        if (revocationReasonHash == bytes32(0)) revert ZeroRevocationReasonHash();
        Attestation storage attestation = _requireAttestation(attestationId);
        if (attestation.issuer != msg.sender) {
            revert IssuerMismatch(attestation.issuer, msg.sender);
        }

        Status currentStatus = _status(attestation);
        if (currentStatus != Status.Active) {
            revert InvalidAttestationStatus(attestationId, currentStatus);
        }

        uint64 timestamp = _timestamp();
        attestation.revokedAt = timestamp;
        attestation.revocationReasonHash = revocationReasonHash;
        emit AttestationRevoked(attestationId, msg.sender, revocationReasonHash, timestamp);
    }

    /// @notice Commits all payload fields, including the optional supersession edge.
    function computeCommitment(
        bytes32 schemaId,
        uint32 schemaVersion,
        bytes32 subject,
        bytes32 referenceHash,
        bytes32 contentHash,
        bytes32 metadataHash,
        bytes32 metadataUriHash,
        bytes32 supersedes
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                schemaId, schemaVersion, subject, referenceHash, contentHash, metadataHash, metadataUriHash, supersedes
            )
        );
    }

    /// @notice Derives the domain-separated ID from issuer nonce and commitment.
    function computeAttestationId(address issuer, uint256 issuerNonce, bytes32 commitment)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), issuer, issuerNonce, commitment));
    }

    /// @notice Derives the permanent replay key; supersedes is intentionally excluded.
    function computeReplayKey(
        address issuer,
        bytes32 schemaId,
        uint32 schemaVersion,
        bytes32 subject,
        bytes32 referenceHash,
        bytes32 contentHash,
        bytes32 metadataHash,
        bytes32 metadataUriHash
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                issuer, schemaId, schemaVersion, subject, referenceHash, contentHash, metadataHash, metadataUriHash
            )
        );
    }

    function statusOf(bytes32 attestationId) public view returns (Status) {
        return _status(_attestations[attestationId]);
    }

    function isActive(bytes32 attestationId) public view returns (bool) {
        return statusOf(attestationId) == Status.Active;
    }

    /// @notice Checks that an active record matches the expected issuer and commitment.
    function verify(bytes32 attestationId, address expectedIssuer, bytes32 expectedCommitment)
        external
        view
        returns (bool)
    {
        Attestation storage attestation = _attestations[attestationId];
        return _status(attestation) == Status.Active && attestation.issuer == expectedIssuer
            && _commitment(attestation) == expectedCommitment;
    }

    function commitmentOf(bytes32 attestationId) external view returns (bytes32) {
        return _commitment(_requireAttestation(attestationId));
    }

    function getAttestation(bytes32 attestationId) external view returns (Attestation memory) {
        return _requireAttestation(attestationId);
    }

    function _validatePayload(
        bytes32 schemaId,
        uint32 schemaVersion,
        bytes32 subject,
        bytes32 contentHash,
        bytes32 metadataHash,
        bytes32 metadataUriHash
    ) private pure {
        if (schemaId == bytes32(0)) revert ZeroSchemaId();
        if (schemaVersion == 0) revert ZeroSchemaVersion();
        if (subject == bytes32(0)) revert ZeroSubject();
        if (contentHash == bytes32(0)) revert ZeroContentHash();
        if (metadataHash == bytes32(0)) revert ZeroMetadataHash();
        if (metadataUriHash == bytes32(0)) revert ZeroMetadataUriHash();
    }

    function _requireAttestation(bytes32 attestationId) private view returns (Attestation storage attestation) {
        attestation = _attestations[attestationId];
        if (attestation.issuer == address(0)) revert AttestationNotFound(attestationId);
    }

    function _status(Attestation storage attestation) private view returns (Status) {
        if (attestation.issuer == address(0)) return Status.Missing;
        if (attestation.revocationReasonHash != bytes32(0)) return Status.Revoked;
        if (attestation.supersededBy != bytes32(0)) return Status.Superseded;
        return Status.Active;
    }

    function _commitment(Attestation storage attestation) private view returns (bytes32) {
        return computeCommitment(
            attestation.schemaId,
            attestation.schemaVersion,
            attestation.subject,
            attestation.referenceHash,
            attestation.contentHash,
            attestation.metadataHash,
            attestation.metadataUriHash,
            attestation.supersedes
        );
    }

    function _timestamp() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow(block.timestamp);
        return uint64(block.timestamp);
    }
}
