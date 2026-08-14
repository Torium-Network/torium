// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ToriumCreate2Factory} from "../../src/deployment/ToriumCreate2Factory.sol";
import {DeploymentFixture} from "../fixtures/DeploymentFixture.sol";
import {EmptyRuntimeFixture} from "../fixtures/EmptyRuntimeFixture.sol";

contract UnauthorizedFixtureCaller {
    function setFixtureValue(DeploymentFixture fixture, uint256 value_) external {
        fixture.setValue(value_);
    }
}

contract ToriumCreate2FactoryTest {
    ToriumCreate2Factory private factory;

    function setUp() public {
        factory = new ToriumCreate2Factory();
    }

    function testDeploysAndResolvesIdenticalInitCode() public {
        bytes32 salt = keccak256("torium.contract-fixture.v1");
        bytes memory initCode = _fixtureInitCode(address(this), 42);
        bytes32 runtimeCodeHash = keccak256(type(DeploymentFixture).runtimeCode);
        address expected = factory.computeAddress(salt, keccak256(initCode));

        address first = factory.deploy(salt, initCode, runtimeCodeHash);
        address second = factory.deploy(salt, initCode, runtimeCodeHash);

        require(first == expected && second == expected, "unexpected deterministic address");
        require(DeploymentFixture(expected).owner() == address(this), "owner mismatch");
        require(DeploymentFixture(expected).value() == 42, "configuration mismatch");
        require(expected.codehash == runtimeCodeHash, "runtime hash mismatch");
    }

    function testRejectsMismatchedExistingRuntimeCode() public {
        bytes32 salt = keccak256("torium.runtime-mismatch.v1");
        bytes memory initCode = _fixtureInitCode(address(this), 7);
        factory.deploy(salt, initCode, keccak256(type(DeploymentFixture).runtimeCode));

        (bool success,) = address(factory).call(abi.encodeCall(factory.deploy, (salt, initCode, bytes32(uint256(1)))));
        require(!success, "mismatched existing code was accepted");
    }

    function testRejectsValueOnExistingDeployment() public {
        bytes32 salt = keccak256("torium.existing-value.v1");
        bytes memory initCode = _fixtureInitCode(address(this), 7);
        bytes32 runtimeCodeHash = keccak256(type(DeploymentFixture).runtimeCode);
        factory.deploy(salt, initCode, runtimeCodeHash);

        (bool success,) =
            address(factory).call{value: 1}(abi.encodeCall(factory.deploy, (salt, initCode, runtimeCodeHash)));
        require(!success, "value was accepted for an existing deployment");
    }

    function testRejectsWrongRuntimeHashAtomically() public {
        bytes32 salt = keccak256("torium.atomic-mismatch.v1");
        bytes memory initCode = _fixtureInitCode(address(this), 9);
        address expected = factory.computeAddress(salt, keccak256(initCode));

        (bool success,) = address(factory).call(abi.encodeCall(factory.deploy, (salt, initCode, bytes32(uint256(1)))));
        require(!success, "wrong runtime hash was accepted");
        require(expected.code.length == 0, "failed deployment left code behind");
    }

    function testRejectsEmptyInitCode() public {
        (bool success,) = address(factory).call(abi.encodeCall(factory.deploy, (bytes32(0), bytes(""), bytes32(0))));
        require(!success, "empty init code was accepted");
    }

    function testRejectsEmptyRuntimeCodeAtomically() public {
        bytes32 salt = keccak256("torium.empty-runtime.v1");
        bytes memory initCode = type(EmptyRuntimeFixture).creationCode;
        address expected = factory.computeAddress(salt, keccak256(initCode));

        (bool success,) = address(factory).call(abi.encodeCall(factory.deploy, (salt, initCode, keccak256(bytes("")))));
        require(!success, "empty runtime code was accepted");
        require(expected.code.length == 0, "empty runtime deployment was retained");
    }

    function testRejectsZeroOwnerConfiguration() public {
        bytes32 salt = keccak256("torium.zero-owner.v1");
        bytes memory initCode = _fixtureInitCode(address(0), 1);
        address expected = factory.computeAddress(salt, keccak256(initCode));

        (bool success,) = address(factory)
            .call(abi.encodeCall(factory.deploy, (salt, initCode, keccak256(type(DeploymentFixture).runtimeCode))));
        require(!success, "zero owner configuration was accepted");
        require(expected.code.length == 0, "invalid configuration left code behind");
    }

    function testFixtureRejectsUnauthorizedRoleMutation() public {
        bytes32 salt = keccak256("torium.role-safety.v1");
        bytes memory initCode = _fixtureInitCode(address(this), 1);
        address deployed = factory.deploy(salt, initCode, keccak256(type(DeploymentFixture).runtimeCode));
        UnauthorizedFixtureCaller caller = new UnauthorizedFixtureCaller();

        (bool success,) = address(caller).call(abi.encodeCall(caller.setFixtureValue, (DeploymentFixture(deployed), 2)));
        require(!success, "unauthorized role mutation was accepted");
        require(DeploymentFixture(deployed).value() == 1, "unauthorized value was stored");
    }

    function testFuzzPredictedAddress(bytes32 salt, uint256 value_) public {
        bytes memory initCode = _fixtureInitCode(address(this), value_);
        bytes32 runtimeCodeHash = keccak256(type(DeploymentFixture).runtimeCode);
        address expected = factory.computeAddress(salt, keccak256(initCode));
        address deployed = factory.deploy(salt, initCode, runtimeCodeHash);

        require(deployed == expected, "fuzzed address mismatch");
        require(DeploymentFixture(deployed).value() == value_, "fuzzed value mismatch");
    }

    function _fixtureInitCode(address owner, uint256 value_) private pure returns (bytes memory) {
        return abi.encodePacked(type(DeploymentFixture).creationCode, abi.encode(owner, value_));
    }
}
