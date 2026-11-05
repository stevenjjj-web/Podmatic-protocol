// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CollectionRegistry} from "./CollectionRegistry.sol";

/// @title FloorBook
/// @notice Tensor-style market-making orders for the interchangeable (floor) part of a collection.
/// @dev Each maker brings their own exponential curve: buying an NFT from the order raises the spot price by `deltaBps`,
///      selling one into it lowers it. The order buys at `spot / (1 + delta) * (1 - fee)` and sells at `spot`, so the
///      maker earns `feeBps` on every round trip. Makers should only deposit floor NFTs: any token can be bought out of
///      an order at its spot price.
contract FloorBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address maker;
        address nft;
        uint128 spotPrice;
        uint16 deltaBps;
        uint16 feeBps;
        uint256 cash;
        bool active;
    }

    uint16 public constant PROTOCOL_FEE_BPS = 100; // 1% taker fee
    uint16 public constant MAX_DELTA_BPS = 5_000;
    uint16 public constant MAX_FEE_BPS = 2_500;

    IERC20 public immutable quote;
    CollectionRegistry public immutable registry;
    address public immutable treasury;

    Order[] internal _orders;
    mapping(uint256 orderId => uint256[]) internal _inventory;

    event OrderCreated(uint256 indexed orderId, address indexed maker, address indexed nft, uint256 spotPrice, uint16 deltaBps, uint16 feeBps);
    event OrderFunded(uint256 indexed orderId, uint256 cash, uint256 nfts);
    event OrderWithdrawn(uint256 indexed orderId, uint256 cash, uint256 nfts);
    event OrderClosed(uint256 indexed orderId);
    event SoldToOrder(uint256 indexed orderId, address indexed seller, uint256 tokenId, uint256 price);
    event BoughtFromOrder(uint256 indexed orderId, address indexed buyer, uint256 tokenId, uint256 price);

    constructor(IERC20 quote_, CollectionRegistry registry_, address treasury_) {
        quote = quote_;
        registry = registry_;
        treasury = treasury_;
    }

    function createOrder(
        address nft,
        uint128 spotPrice,
        uint16 deltaBps,
        uint16 feeBps,
        uint256 cash,
        uint256[] calldata tokenIds
    ) external nonReentrant returns (uint256 orderId) {
        require(registry.isRegistered(nft), "unregistered");
        require(spotPrice > 0 && deltaBps <= MAX_DELTA_BPS && feeBps <= MAX_FEE_BPS, "bad curve");
        orderId = _orders.length;
        _orders.push(Order(msg.sender, nft, spotPrice, deltaBps, feeBps, 0, true));
        emit OrderCreated(orderId, msg.sender, nft, spotPrice, deltaBps, feeBps);
        _fund(orderId, cash, tokenIds);
    }

    function fund(uint256 orderId, uint256 cash, uint256[] calldata tokenIds) external nonReentrant {
        require(_orders[orderId].maker == msg.sender && _orders[orderId].active, "not your order");
        _fund(orderId, cash, tokenIds);
    }

    function withdraw(uint256 orderId, uint256 cash, uint256 nftCount) public nonReentrant {
        Order storage o = _orders[orderId];
        require(o.maker == msg.sender, "not your order");
        require(o.cash >= cash, "cash");
        uint256[] storage inv = _inventory[orderId];
        require(inv.length >= nftCount, "nfts");
        o.cash -= cash;
        quote.safeTransfer(msg.sender, cash);
        for (uint256 i; i < nftCount; ++i) {
            uint256 tokenId = inv[inv.length - 1];
            inv.pop();
            IERC721(o.nft).transferFrom(address(this), msg.sender, tokenId);
        }
        emit OrderWithdrawn(orderId, cash, nftCount);
    }

    function close(uint256 orderId) external {
        Order storage o = _orders[orderId];
        withdraw(orderId, o.cash, _inventory[orderId].length);
        o.active = false;
        emit OrderClosed(orderId);
    }

    /// @notice Price the order pays for the next NFT sold into it.
    function bidPrice(uint256 orderId) public view returns (uint256) {
        Order storage o = _orders[orderId];
        uint256 down = (uint256(o.spotPrice) * 10_000) / (10_000 + o.deltaBps);
        return (down * (10_000 - o.feeBps)) / 10_000;
    }

    /// @notice Price the order charges for the next NFT bought from it.
    function askPrice(uint256 orderId) public view returns (uint256) {
        return _orders[orderId].spotPrice;
    }

    function sellToOrder(uint256 orderId, uint256 tokenId, uint256 minOut) external nonReentrant returns (uint256 price) {
        Order storage o = _orders[orderId];
        require(o.active, "inactive");
        price = bidPrice(orderId);
        require(o.cash >= price, "order out of cash");
        uint256 fee = (price * PROTOCOL_FEE_BPS) / 10_000;
        require(price - fee >= minOut, "slippage");

        o.cash -= price;
        o.spotPrice = uint128((uint256(o.spotPrice) * 10_000) / (10_000 + o.deltaBps));
        _inventory[orderId].push(tokenId);
        IERC721(o.nft).transferFrom(msg.sender, address(this), tokenId);
        quote.safeTransfer(msg.sender, price - fee);
        if (fee > 0) quote.safeTransfer(treasury, fee);
        emit SoldToOrder(orderId, msg.sender, tokenId, price);
    }

    function buyFromOrder(uint256 orderId, uint256 maxIn) external nonReentrant returns (uint256 tokenId) {
        Order storage o = _orders[orderId];
        require(o.active, "inactive");
        uint256[] storage inv = _inventory[orderId];
        require(inv.length > 0, "order empty");
        uint256 price = o.spotPrice;
        uint256 fee = (price * PROTOCOL_FEE_BPS) / 10_000;
        require(price + fee <= maxIn, "slippage");

        tokenId = inv[inv.length - 1];
        inv.pop();
        o.cash += price;
        o.spotPrice = uint128((price * (10_000 + o.deltaBps)) / 10_000);
        quote.safeTransferFrom(msg.sender, address(this), price);
        if (fee > 0) quote.safeTransferFrom(msg.sender, treasury, fee);
        IERC721(o.nft).transferFrom(address(this), msg.sender, tokenId);
        emit BoughtFromOrder(orderId, msg.sender, tokenId, price);
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function orders(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function inventory(uint256 orderId) external view returns (uint256[] memory) {
        return _inventory[orderId];
    }

    function _fund(uint256 orderId, uint256 cash, uint256[] calldata tokenIds) internal {
        Order storage o = _orders[orderId];
        if (cash > 0) {
            quote.safeTransferFrom(msg.sender, address(this), cash);
            o.cash += cash;
        }
        for (uint256 i; i < tokenIds.length; ++i) {
            IERC721(o.nft).transferFrom(msg.sender, address(this), tokenIds[i]);
            _inventory[orderId].push(tokenIds[i]);
        }
        emit OrderFunded(orderId, cash, tokenIds.length);
    }
}
