// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Source of verifiable randomness. Production uses Chainlink VRF v2.5; local dev uses a mock.
interface IRandomnessProvider {
    function requestRandomness() external returns (uint256 requestId);
}

/// @notice Implemented by contracts that consume randomness.
interface IRandomnessConsumer {
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external;
}
