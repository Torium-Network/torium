// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ToriumCreate2Factory} from "../../src/deployment/ToriumCreate2Factory.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function deal(address account, uint256 newBalance) external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function recordLogs() external;
}

contract PayableDeploymentFixture {
    address public owner;
    uint256 public configuredValue;
    uint256 public receivedValue;

    constructor(address owner_, uint256 configuredValue_) payable {
        owner = owner_;
        configuredValue = configuredValue_;
        receivedValue = msg.value;
    }
}

contract ToriumCreate2FactoryAssuranceTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant DEPLOYED_EVENT = keccak256("ContractDeployed(address,bytes32,bytes32,bytes32)");

    ToriumCreate2Factory private _factory;

    function setUp() public {
        _factory = new ToriumCreate2Factory();
        VM.deal(address(this), 100 ether);
    }

    function testDeploymentEventReconcilesAndIdempotentResolutionEmitsNothing() public {
        bytes32 salt = keccak256("assurance.factory.event.v1");
        bytes memory initCode = _initCode(address(this), 77);
        bytes32 initCodeHash = keccak256(initCode);
        bytes32 runtimeHash = keccak256(type(PayableDeploymentFixture).runtimeCode);
        address expected = _factory.computeAddress(salt, initCodeHash);

        VM.recordLogs();
        address deployed = _factory.deploy(salt, initCode, runtimeHash);
        Vm.Log[] memory deploymentLogs = VM.getRecordedLogs();

        require(deployed == expected, "deployment address mismatch");
        require(deploymentLogs.length == 1, "unexpected deployment log count");
        require(deploymentLogs[0].emitter == address(_factory), "wrong event emitter");
        require(deploymentLogs[0].topics.length == 4, "wrong indexed topic count");
        require(deploymentLogs[0].topics[0] == DEPLOYED_EVENT, "wrong event signature");
        require(deploymentLogs[0].topics[1] == bytes32(uint256(uint160(expected))), "wrong deployment topic");
        require(deploymentLogs[0].topics[2] == salt, "wrong salt topic");
        require(deploymentLogs[0].topics[3] == initCodeHash, "wrong init-code topic");
        require(abi.decode(deploymentLogs[0].data, (bytes32)) == runtimeHash, "wrong runtime hash data");

        VM.recordLogs();
        address resolved = _factory.deploy(salt, initCode, runtimeHash);
        Vm.Log[] memory resolutionLogs = VM.getRecordedLogs();
        require(resolved == expected, "idempotent resolution drift");
        require(resolutionLogs.length == 0, "resolution looked like a deployment");
    }

    function testFuzzValueForwardingIsExactAndCannotBeRepeated(bytes32 salt, uint96 rawValue, uint128 configuredValue)
        public
    {
        uint256 value = uint256(rawValue) % 10 ether + 1;
        bytes memory initCode = _initCode(address(this), configuredValue);
        bytes32 runtimeHash = keccak256(type(PayableDeploymentFixture).runtimeCode);
        address deployed = _factory.deploy{value: value}(salt, initCode, runtimeHash);
        PayableDeploymentFixture fixture = PayableDeploymentFixture(deployed);

        require(fixture.owner() == address(this), "owner configuration drift");
        require(fixture.configuredValue() == configuredValue, "constructor configuration drift");
        require(fixture.receivedValue() == value, "forwarded value drift");
        require(deployed.balance == value, "deployed balance drift");

        (bool success,) =
            address(_factory).call{value: 1}(abi.encodeCall(_factory.deploy, (salt, initCode, runtimeHash)));
        require(!success, "existing deployment accepted value");
        require(deployed.balance == value, "failed replay changed deployed balance");
    }

    function testGasFactoryDeploy() public {
        bytes memory initCode = _initCode(address(this), 1);
        _factory.deploy(
            keccak256("gas.factory.deploy"), initCode, keccak256(type(PayableDeploymentFixture).runtimeCode)
        );
    }

    function testGasFactoryResolve() public {
        bytes32 salt = keccak256("gas.factory.resolve");
        bytes memory initCode = _initCode(address(this), 1);
        bytes32 runtimeHash = keccak256(type(PayableDeploymentFixture).runtimeCode);
        _factory.deploy(salt, initCode, runtimeHash);
        _factory.deploy(salt, initCode, runtimeHash);
    }

    function _initCode(address owner, uint256 configuredValue) private pure returns (bytes memory) {
        return abi.encodePacked(type(PayableDeploymentFixture).creationCode, abi.encode(owner, configuredValue));
    }
}
