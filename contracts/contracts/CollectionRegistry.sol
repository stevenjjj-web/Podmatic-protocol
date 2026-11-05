// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title CollectionRegistry
/// @notice Registers NFT collections and a snapshot of their traits.
/// @dev Traits are committed as a Merkle root over leaves `keccak256(bytes.concat(keccak256(abi.encode(tokenId, traitKey))))`
///      (OpenZeppelin StandardMerkleTree format). Many collections have mutable metadata, so the protocol only trusts
///      the snapshot. Registration is permissioned during the MVP; the owner should be a multisig.
contract CollectionRegistry is Ownable {
    struct Collection {
        bool registered;
        bytes32 traitRoot;
        string name;
    }

    /// @notice Trait bids can only price NFTs if at least this many tokens share the trait, so that a bidder cannot
    ///         appraise a single item they control.
    uint256 public constant MIN_TRAIT_HOLDERS = 5;

    mapping(address nft => Collection) public collections;
    mapping(address nft => mapping(bytes32 traitKey => uint256)) public traitCount;
    address[] public collectionList;

    event CollectionRegistered(address indexed nft, string name, bytes32 traitRoot);
    event TraitCountsSet(address indexed nft, uint256 traits);

    constructor(address owner_) Ownable(owner_) {}

    function register(address nft, string calldata name, bytes32 traitRoot) external onlyOwner {
        Collection storage c = collections[nft];
        if (!c.registered) collectionList.push(nft);
        c.registered = true;
        c.traitRoot = traitRoot;
        c.name = name;
        emit CollectionRegistered(nft, name, traitRoot);
    }

    function setTraitCounts(address nft, bytes32[] calldata keys, uint256[] calldata counts) external onlyOwner {
        require(keys.length == counts.length, "length");
        for (uint256 i; i < keys.length; ++i) {
            traitCount[nft][keys[i]] = counts[i];
        }
        emit TraitCountsSet(nft, keys.length);
    }

    function isRegistered(address nft) external view returns (bool) {
        return collections[nft].registered;
    }

    function collectionCount() external view returns (uint256) {
        return collectionList.length;
    }

    /// @notice A trait can back valuations only if enough tokens share it. `traitKey == 0` means collection-wide.
    function isValuationTrait(address nft, bytes32 traitKey) public view returns (bool) {
        return traitKey == bytes32(0) || traitCount[nft][traitKey] >= MIN_TRAIT_HOLDERS;
    }

    /// @notice Checks that `tokenId` has `traitKey` in the snapshot. `traitKey == 0` is true for any token.
    function verifyTrait(address nft, uint256 tokenId, bytes32 traitKey, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Collection storage c = collections[nft];
        if (!c.registered) return false;
        if (traitKey == bytes32(0)) return true;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(tokenId, traitKey))));
        return MerkleProof.verifyCalldata(proof, c.traitRoot, leaf);
    }
}
