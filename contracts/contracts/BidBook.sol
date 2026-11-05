// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CollectionRegistry} from "./CollectionRegistry.sol";

interface IMachineRegistry {
    function isMachine(address account) external view returns (bool);
}

/// @title BidBook
/// @notice Collection-wide and trait bids backed by a shared escrow balance per bidder.
/// @dev One balance backs many bids (as on Tensor). A bid is fillable while the bidder's unreserved balance covers its
///      price. When a machine uses a bid to value an NFT it draws, it earmarks the bid's price for an exit window, so the
///      winner can always sell the NFT to that bid. Only collection and trait bids exist: an item-specific bid could be
///      used by a seller to appraise their own NFT.
contract BidBook is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Bid {
        address bidder;
        address nft;
        bytes32 traitKey; // 0 = any token in the collection
        uint128 price;
        uint32 remaining; // fills left, including outstanding earmarks
        uint64 updatedAt; // reset whenever the price is raised
        bool active;
    }

    struct Earmark {
        uint256 bidId;
        address bidder;
        address nft;
        uint256 tokenId;
        uint128 amount;
        uint64 expiry;
        bool open;
    }

    /// @notice A bid must rest this long before it can value NFTs, so a bid cannot be raised just before a draw.
    uint64 public constant MIN_BID_AGE = 1 days;
    uint16 public constant FEE_BPS = 100; // 1% taker fee on fills

    IERC20 public immutable quote;
    CollectionRegistry public immutable registry;
    address public treasury;
    IMachineRegistry public machineRegistry;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public earmarkedOf;
    Bid[] internal _bids;
    Earmark[] internal _earmarks;

    event Deposited(address indexed bidder, uint256 amount);
    event Withdrawn(address indexed bidder, uint256 amount);
    event BidPlaced(uint256 indexed bidId, address indexed bidder, address indexed nft, bytes32 traitKey, uint256 price, uint256 fills);
    event BidUpdated(uint256 indexed bidId, uint256 price, uint256 remaining);
    event BidCancelled(uint256 indexed bidId);
    event BidFilled(uint256 indexed bidId, address indexed seller, uint256 tokenId, uint256 price);
    event EarmarkCreated(uint256 indexed earmarkId, uint256 indexed bidId, address indexed nft, uint256 tokenId, uint256 amount, uint64 expiry);
    event EarmarkFilled(uint256 indexed earmarkId, address indexed seller);
    event EarmarkReleased(uint256 indexed earmarkId);

    constructor(IERC20 quote_, CollectionRegistry registry_, address treasury_, address owner_) Ownable(owner_) {
        quote = quote_;
        registry = registry_;
        treasury = treasury_;
    }

    /// @notice Set once at deployment: the factory that vouches for machine contracts allowed to earmark bids.
    function setMachineRegistry(IMachineRegistry machineRegistry_) external onlyOwner {
        require(address(machineRegistry) == address(0), "already set");
        machineRegistry = machineRegistry_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
    }

    // ------------------------------------------------------------------ escrow

    function deposit(uint256 amount) external nonReentrant {
        quote.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(available(msg.sender) >= amount, "insufficient free balance");
        balanceOf[msg.sender] -= amount;
        quote.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function available(address bidder) public view returns (uint256) {
        return balanceOf[bidder] - earmarkedOf[bidder];
    }

    // ------------------------------------------------------------------ bids

    function placeBid(address nft, bytes32 traitKey, uint128 price, uint32 fills) external returns (uint256 bidId) {
        require(registry.isRegistered(nft), "unregistered");
        require(registry.isValuationTrait(nft, traitKey), "trait too rare");
        require(price > 0 && fills > 0, "empty bid");
        bidId = _bids.length;
        _bids.push(Bid(msg.sender, nft, traitKey, price, fills, uint64(block.timestamp), true));
        emit BidPlaced(bidId, msg.sender, nft, traitKey, price, fills);
    }

    /// @notice Lowering the price keeps the bid's age; raising it restarts the age clock.
    function updateBid(uint256 bidId, uint128 price, uint32 remaining) external {
        Bid storage b = _bids[bidId];
        require(b.bidder == msg.sender && b.active, "not your bid");
        require(price > 0, "zero price");
        if (price > b.price) b.updatedAt = uint64(block.timestamp);
        b.price = price;
        b.remaining = remaining;
        emit BidUpdated(bidId, price, remaining);
    }

    function cancelBid(uint256 bidId) external {
        Bid storage b = _bids[bidId];
        require(b.bidder == msg.sender && b.active, "not your bid");
        b.active = false;
        emit BidCancelled(bidId);
    }

    /// @notice Sell an NFT into a bid. Trait bids need a proof against the registry snapshot.
    function fill(uint256 bidId, uint256 tokenId, bytes32[] calldata proof, uint128 minPrice) external nonReentrant {
        Bid storage b = _bids[bidId];
        require(b.active && b.remaining > 0, "bid closed");
        require(b.price >= minPrice, "price moved");
        require(registry.verifyTrait(b.nft, tokenId, b.traitKey, proof), "trait mismatch");
        uint256 price = b.price;
        require(available(b.bidder) >= price, "bid underfunded");

        b.remaining -= 1;
        balanceOf[b.bidder] -= price;
        IERC721(b.nft).transferFrom(msg.sender, b.bidder, tokenId);
        _payout(msg.sender, price);
        emit BidFilled(bidId, msg.sender, tokenId, price);
    }

    // ------------------------------------------------------------------ valuation & earmarks

    /// @notice True if the bid can currently value an NFT of `nft` that carries `traitKey`.
    function isValuationEligible(uint256 bidId, address nft, bytes32 traitKey) public view returns (bool) {
        if (bidId >= _bids.length) return false;
        Bid storage b = _bids[bidId];
        return b.active && b.remaining > 0 && b.nft == nft && (b.traitKey == bytes32(0) || b.traitKey == traitKey)
            && block.timestamp >= b.updatedAt + MIN_BID_AGE && available(b.bidder) >= b.price;
    }

    /// @notice Called by a machine when it awards an NFT valued by this bid. Reserves the bid price until `expiry` so
    ///         the winner can sell the NFT to the bid. Reverts if the bid can no longer back the valuation.
    function earmark(uint256 bidId, bytes32 traitKey, uint256 tokenId, uint64 expiry)
        external
        returns (uint256 earmarkId, address bidder, uint256 amount)
    {
        require(address(machineRegistry) != address(0) && machineRegistry.isMachine(msg.sender), "not a machine");
        Bid storage b = _bids[bidId];
        require(isValuationEligible(bidId, b.nft, traitKey), "bid not eligible");
        bidder = b.bidder;
        amount = b.price;
        b.remaining -= 1;
        earmarkedOf[bidder] += amount;
        earmarkId = _earmarks.length;
        _earmarks.push(Earmark(bidId, bidder, b.nft, tokenId, uint128(amount), expiry, true));
        emit EarmarkCreated(earmarkId, bidId, b.nft, tokenId, amount, expiry);
    }

    /// @notice The current owner of the earmarked NFT sells it to the bidder at the reserved price.
    function fillEarmark(uint256 earmarkId) external nonReentrant {
        Earmark storage e = _earmarks[earmarkId];
        require(e.open && block.timestamp <= e.expiry, "earmark closed");
        e.open = false;
        earmarkedOf[e.bidder] -= e.amount;
        balanceOf[e.bidder] -= e.amount;
        IERC721(e.nft).transferFrom(msg.sender, e.bidder, e.tokenId);
        _payout(msg.sender, e.amount);
        emit EarmarkFilled(earmarkId, msg.sender);
    }

    /// @notice Anyone can release an expired earmark; the bid gets its fill back.
    function releaseEarmark(uint256 earmarkId) external {
        Earmark storage e = _earmarks[earmarkId];
        require(e.open && block.timestamp > e.expiry, "not expired");
        e.open = false;
        earmarkedOf[e.bidder] -= e.amount;
        Bid storage b = _bids[e.bidId];
        if (b.active) b.remaining += 1;
        emit EarmarkReleased(earmarkId);
    }

    // ------------------------------------------------------------------ views

    function bidCount() external view returns (uint256) {
        return _bids.length;
    }

    function bids(uint256 bidId) external view returns (Bid memory) {
        return _bids[bidId];
    }

    function earmarkCount() external view returns (uint256) {
        return _earmarks.length;
    }

    function earmarks(uint256 earmarkId) external view returns (Earmark memory) {
        return _earmarks[earmarkId];
    }

    function _payout(address to, uint256 amount) internal {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        quote.safeTransfer(to, amount - fee);
        if (fee > 0) quote.safeTransfer(treasury, fee);
    }
}
