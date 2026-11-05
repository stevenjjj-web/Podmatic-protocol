// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IRandomness.sol";

/// @dev Minimal subset of Chainlink VRF v2.5 (VRFV2PlusClient / IVRFCoordinatorV2Plus).
library VRFV2PlusClient {
    bytes4 internal constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    struct ExtraArgsV1 {
        bool nativePayment;
    }

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function argsToBytes(ExtraArgsV1 memory extraArgs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, extraArgs);
    }
}

interface IVRFCoordinatorV2Plus {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/// @title ChainlinkVRFProvider
/// @notice Routes randomness requests from Podmatic contracts to Chainlink VRF v2.5 and forwards the result.
/// @dev This contract must be added as a consumer of the VRF subscription. Only authorized consumers may request, so
///      nobody else can spend the subscription. Coordinator, key hash and subscription differ per chain; see
///      https://docs.chain.link/vrf/v2-5/supported-networks. A consumer callback that reverts is caught so the VRF
///      fulfilment succeeds; the consumer's own timeout path then refunds the user.
contract ChainlinkVRFProvider is IRandomnessProvider, Ownable {
    IVRFCoordinatorV2Plus public immutable coordinator;
    bytes32 public keyHash;
    uint256 public subscriptionId;
    uint16 public requestConfirmations;
    uint32 public callbackGasLimit;
    bool public nativePayment;

    mapping(address => bool) public isConsumer;
    mapping(address => bool) public isAuthorizer;
    mapping(uint256 requestId => address) public consumerOf;

    event ConsumerSet(address indexed consumer, bool allowed);
    event AuthorizerSet(address indexed authorizer, bool allowed);
    event CallbackFailed(uint256 indexed requestId, address indexed consumer);

    constructor(
        IVRFCoordinatorV2Plus coordinator_,
        bytes32 keyHash_,
        uint256 subscriptionId_,
        uint16 requestConfirmations_,
        uint32 callbackGasLimit_,
        address owner_
    ) Ownable(owner_) {
        coordinator = coordinator_;
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
        requestConfirmations = requestConfirmations_;
        callbackGasLimit = callbackGasLimit_;
    }

    function setConfig(bytes32 keyHash_, uint256 subscriptionId_, uint16 confirmations_, uint32 gasLimit_, bool native_)
        external
        onlyOwner
    {
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
        requestConfirmations = confirmations_;
        callbackGasLimit = gasLimit_;
        nativePayment = native_;
    }

    function setAuthorizer(address authorizer, bool allowed) external onlyOwner {
        isAuthorizer[authorizer] = allowed;
        emit AuthorizerSet(authorizer, allowed);
    }

    function setConsumer(address consumer, bool allowed) external {
        require(msg.sender == owner() || isAuthorizer[msg.sender], "not authorized");
        isConsumer[consumer] = allowed;
        emit ConsumerSet(consumer, allowed);
    }

    function requestRandomness() external returns (uint256 requestId) {
        require(isConsumer[msg.sender], "not a consumer");
        requestId = coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient.argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
        consumerOf[requestId] = msg.sender;
    }

    /// @notice Called by the VRF coordinator.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        require(msg.sender == address(coordinator), "only coordinator");
        address consumer = consumerOf[requestId];
        delete consumerOf[requestId];
        if (consumer == address(0)) return;
        try IRandomnessConsumer(consumer).fulfillRandomness(requestId, randomWords[0]) {}
        catch {
            emit CallbackFailed(requestId, consumer);
        }
    }
}
