// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Machine} from "./Machine.sol";
import {CollectionRegistry} from "./CollectionRegistry.sol";
import {BidBook} from "./BidBook.sol";
import {IRandomnessProvider} from "./interfaces/IRandomness.sol";

interface IConsumerRegistry {
    function setConsumer(address consumer, bool allowed) external;
}

/// @title MachineFactory
/// @notice Permissionless machine creation. Deploys minimal clones of one audited Machine implementation and vouches
///         for them to the BidBook (earmarks) and the randomness provider.
contract MachineFactory {
    address public immutable implementation;
    IERC20 public immutable quote;
    CollectionRegistry public immutable registry;
    BidBook public immutable bidBook;
    IRandomnessProvider public immutable randomness;
    address public immutable treasury;

    mapping(address => bool) public isMachine;
    address[] public machines;

    event MachineCreated(address indexed machine, address indexed creator, address indexed nft, string name);

    constructor(
        address implementation_,
        IERC20 quote_,
        CollectionRegistry registry_,
        BidBook bidBook_,
        IRandomnessProvider randomness_,
        address treasury_
    ) {
        implementation = implementation_;
        quote = quote_;
        registry = registry_;
        bidBook = bidBook_;
        randomness = randomness_;
        treasury = treasury_;
    }

    function createMachine(Machine.Init calldata p) external returns (address machine) {
        require(registry.isRegistered(p.nft), "unregistered collection");
        machine = Clones.clone(implementation);
        Machine(machine).initialize(
            p,
            Machine.Deps({
                creator: msg.sender,
                factory: address(this),
                treasury: treasury,
                quote: quote,
                registry: registry,
                bidBook: bidBook,
                randomness: randomness
            })
        );
        isMachine[machine] = true;
        machines.push(machine);
        IConsumerRegistry(address(randomness)).setConsumer(machine, true);
        emit MachineCreated(machine, msg.sender, p.nft, p.name);
    }

    function machineCount() external view returns (uint256) {
        return machines.length;
    }

    function allMachines() external view returns (address[] memory) {
        return machines;
    }
}
