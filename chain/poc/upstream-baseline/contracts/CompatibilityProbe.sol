// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract CompatibilityProbe {
    uint256 public value;

    event ValueChanged(uint256 indexed previousValue, uint256 indexed newValue);

    function setValue(uint256 newValue) external {
        uint256 previousValue = value;
        value = newValue;
        emit ValueChanged(previousValue, newValue);
    }
}
