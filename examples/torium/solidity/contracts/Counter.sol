// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract Counter {
    uint256 public number;

    event NumberChanged(uint256 indexed previousNumber, uint256 indexed newNumber);

    function setNumber(uint256 newNumber) external {
        uint256 previousNumber = number;
        number = newNumber;
        emit NumberChanged(previousNumber, newNumber);
    }
}
