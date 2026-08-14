// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

contract DeploymentFixture {
    error Unauthorized(address caller);

    address public owner;
    uint256 public value;

    constructor(address owner_, uint256 value_) {
        if (owner_ == address(0)) revert Unauthorized(address(0));
        owner = owner_;
        value = value_;
    }

    function setValue(uint256 value_) external {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        value = value_;
    }
}
