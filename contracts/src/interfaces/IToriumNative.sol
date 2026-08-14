// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.30;

/// @title Canonical Torium native asset interface
/// @notice ERC-20/WETH-compatible view of the same x/bank atorium ledger used
///         by EVM value and gas. This facade never creates wrapped supply.
interface IToriumNative {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed account, uint256 value);
    event Withdrawal(address indexed account, uint256 value);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);

    /// @notice Compatibility operation: msg.value is returned to the caller's
    ///         native balance and a Deposit event is emitted. No wrap occurs.
    function deposit() external payable;

    /// @notice Compatibility operation: validates native balance and emits a
    ///         Withdrawal event. No balance or supply mutation occurs.
    function withdraw(uint256 value) external;

    fallback() external payable;
    receive() external payable;
}
