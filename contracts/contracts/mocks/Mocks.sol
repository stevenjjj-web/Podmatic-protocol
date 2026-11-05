// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/// @notice LOCAL/TESTNET ONLY. 6-decimal stand-in for USDC with an open faucet.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice LOCAL/TESTNET ONLY. Demo PFP collection with an open mint.
contract MockCollection is ERC721Enumerable {
    string private _base;
    uint256 public nextId;

    constructor(string memory name_, string memory symbol_, string memory base_) ERC721(name_, symbol_) {
        _base = base_;
    }

    function mint(address to, uint256 count) external {
        for (uint256 i; i < count; ++i) {
            _mint(to, nextId++);
        }
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }
}

interface IVRFProviderCallback {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @notice TESTS ONLY. Records VRF v2.5 requests and lets tests deliver the words.
contract MockVRFCoordinatorV2Plus {
    uint256 public nextRequestId = 1;
    mapping(uint256 => address) public requester;
    bytes public lastExtraArgs;
    uint32 public lastCallbackGasLimit;

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        requester[requestId] = msg.sender;
        lastExtraArgs = req.extraArgs;
        lastCallbackGasLimit = req.callbackGasLimit;
    }

    function deliver(uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IVRFProviderCallback(requester[requestId]).rawFulfillRandomWords(requestId, words);
    }
}

/// @notice TESTS ONLY. A consumer whose callback always reverts.
contract RevertingConsumer {
    function request(address provider) external returns (uint256) {
        return IRandomnessRequester(provider).requestRandomness();
    }

    function fulfillRandomness(uint256, uint256) external pure {
        revert("boom");
    }
}

interface IRandomnessRequester {
    function requestRandomness() external returns (uint256);
}
