// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/// @title Torium deterministic deployment factory
/// @notice Permissionless, stateless CREATE2 deployment infrastructure. It is
///         post-genesis tooling and has no owner, admin, upgrader, or custody.
contract ToriumCreate2Factory {
    error EmptyInitCode();
    error EmptyRuntimeCode(address deployment);
    error ExistingRuntimeCodeMismatch(
        address deployment, bytes32 expectedRuntimeCodeHash, bytes32 actualRuntimeCodeHash
    );
    error DeploymentFailed(address expectedDeployment);
    error UnexpectedValueForExistingDeployment(address deployment, uint256 value);

    event ContractDeployed(
        address indexed deployment, bytes32 indexed salt, bytes32 indexed initCodeHash, bytes32 runtimeCodeHash
    );

    function computeAddress(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return Create2.computeAddress(salt, initCodeHash, address(this));
    }

    function deploy(bytes32 salt, bytes calldata initCode, bytes32 expectedRuntimeCodeHash)
        external
        payable
        returns (address deployment)
    {
        if (initCode.length == 0) revert EmptyInitCode();
        bytes32 initCodeHash = keccak256(initCode);
        deployment = computeAddress(salt, initCodeHash);

        if (deployment.code.length != 0) {
            if (msg.value != 0) {
                revert UnexpectedValueForExistingDeployment(deployment, msg.value);
            }
            _requireRuntimeCode(deployment, expectedRuntimeCodeHash);
            return deployment;
        }

        bytes memory creationCode = initCode;
        uint256 value = msg.value;
        assembly ("memory-safe") {
            deployment := create2(value, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (deployment == address(0)) revert DeploymentFailed(computeAddress(salt, initCodeHash));
        _requireRuntimeCode(deployment, expectedRuntimeCodeHash);
        emit ContractDeployed(deployment, salt, initCodeHash, expectedRuntimeCodeHash);
    }

    function _requireRuntimeCode(address deployment, bytes32 expectedRuntimeCodeHash) private view {
        if (deployment.code.length == 0) revert EmptyRuntimeCode(deployment);
        bytes32 actualRuntimeCodeHash = deployment.codehash;
        if (actualRuntimeCodeHash != expectedRuntimeCodeHash) {
            revert ExistingRuntimeCodeMismatch(deployment, expectedRuntimeCodeHash, actualRuntimeCodeHash);
        }
    }
}
