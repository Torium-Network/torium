// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

contract EmptyRuntimeFixture {
    constructor() {
        assembly ("memory-safe") {
            return(0, 0)
        }
    }
}
