// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ReserveVault
/// @notice USDC reserve with LP shares, shared by machines and the odds market.
/// @dev Shares are non-transferable while the legal status of LP shares is open. Withdrawals go through a one-day
///      queue: queued shares keep bearing profit and loss until claimed, so an LP cannot see a large payout coming and
///      exit ahead of it. Virtual shares (1e6) blunt the first-depositor inflation attack.
abstract contract ReserveVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct WithdrawRequest {
        uint256 shares;
        uint64 unlockAt;
    }

    uint64 public constant WITHDRAW_DELAY = 1 days;
    uint256 internal constant VIRTUAL_SHARES = 1e6;

    IERC20 public quote;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => WithdrawRequest) public withdrawRequests;

    event LiquidityDeposited(address indexed lp, uint256 assets, uint256 shares);
    event WithdrawRequested(address indexed lp, uint256 shares, uint64 unlockAt);
    event WithdrawClaimed(address indexed lp, uint256 shares, uint256 assets);

    /// @notice Assets that belong to LPs (cash minus money held for pending requests).
    function totalAssets() public view virtual returns (uint256);

    function convertToShares(uint256 assets) public view returns (uint256) {
        return (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets() + 1);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * (totalAssets() + 1)) / (totalShares + VIRTUAL_SHARES);
    }

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        shares = convertToShares(assets);
        require(shares > 0, "zero shares");
        quote.safeTransferFrom(msg.sender, address(this), assets);
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit LiquidityDeposited(msg.sender, assets, shares);
    }

    /// @notice Queue shares for withdrawal. Adds to any existing request and restarts its timer.
    function requestWithdraw(uint256 shares) external {
        require(shares > 0 && sharesOf[msg.sender] >= shares, "shares");
        sharesOf[msg.sender] -= shares;
        WithdrawRequest storage r = withdrawRequests[msg.sender];
        r.shares += shares;
        r.unlockAt = uint64(block.timestamp) + WITHDRAW_DELAY;
        emit WithdrawRequested(msg.sender, r.shares, r.unlockAt);
    }

    function claimWithdraw() external nonReentrant returns (uint256 assets) {
        WithdrawRequest memory r = withdrawRequests[msg.sender];
        require(r.shares > 0 && block.timestamp >= r.unlockAt, "locked");
        assets = convertToAssets(r.shares);
        delete withdrawRequests[msg.sender];
        totalShares -= r.shares;
        quote.safeTransfer(msg.sender, assets);
        emit WithdrawClaimed(msg.sender, r.shares, assets);
    }
}
