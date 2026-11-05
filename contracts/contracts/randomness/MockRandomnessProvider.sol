// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IRandomness.sol";

/// @title MockRandomnessProvider
/// @notice LOCAL DEVELOPMENT ONLY. Anyone can fulfil a pending request with pseudo-randomness, or with a chosen word.
///         Never deploy this to a public network.
contract MockRandomnessProvider is IRandomnessProvider {
    uint256 public nextRequestId = 1;
    mapping(uint256 requestId => address) public consumerOf;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);

    function setConsumer(address, bool) external {}

    function requestRandomness() external returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumerOf[requestId] = msg.sender;
        emit RandomnessRequested(requestId, msg.sender);
    }

    function fulfill(uint256 requestId) external {
        uint256 word = uint256(keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, requestId, msg.sender)));
        _fulfill(requestId, word);
    }

    function fulfillWith(uint256 requestId, uint256 word) external {
        _fulfill(requestId, word);
    }

    function _fulfill(uint256 requestId, uint256 word) internal {
        address consumer = consumerOf[requestId];
        require(consumer != address(0), "unknown request");
        delete consumerOf[requestId];
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, word);
        emit RandomnessFulfilled(requestId, word);
    }
}
