// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReserveVault} from "./ReserveVault.sol";
import {CollectionRegistry} from "./CollectionRegistry.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomness.sol";

/// @title OddsMarket
/// @notice Probabilistic purchases of specific NFTs, inspired by Tensor's YOLO Buy.
/// @dev A seller escrows an NFT with an ask A. A buyer pays q * A plus a fee for probability q of winning it. On a win
///      the vault pays the seller A plus a bonus and the buyer receives the NFT; on a loss the stake stays in the vault.
///      The seller's own ask is safe to use here because the buyer sees exactly which NFT they are buying odds on: an
///      overpriced ask simply attracts no buyers. The vault's expected profit is its fee share minus the seller bonus;
///      it carries the variance, so an ask may not exceed `RISK_BPS` of the vault.
contract OddsMarket is ReserveVault, IRandomnessConsumer {
    using SafeERC20 for IERC20;

    struct OddsListing {
        address seller;
        address nft;
        uint256 tokenId;
        uint128 ask;
        bool active;
        bool pending;
    }

    struct OddsRequest {
        uint256 listingId;
        address buyer;
        address frontend;
        uint16 qBps;
        uint128 stake;
        uint64 createdAt;
        bool pending;
    }

    uint16 public constant MIN_Q_BPS = 100; // 1%
    uint16 public constant MAX_Q_BPS = 5_000; // 50%
    uint16 public constant PROTOCOL_FEE_BPS = 150; // of stake
    uint16 public constant FRONTEND_FEE_BPS = 100; // of stake
    uint16 public constant VAULT_FEE_BPS = 350; // of stake
    uint16 public constant SELLER_BONUS_BPS = 150; // of ask, paid on a win
    uint16 public constant RISK_BPS = 1_000; // ask + bonus <= 10% of vault assets
    uint64 public constant REQUEST_TIMEOUT = 1 days;

    CollectionRegistry public immutable registry;
    IRandomnessProvider public immutable randomness;
    address public immutable treasury;

    OddsListing[] internal _listings;
    mapping(uint256 requestId => OddsRequest) public requests;
    uint256 public pendingEscrow;

    event OddsListed(uint256 indexed listingId, address indexed seller, address indexed nft, uint256 tokenId, uint256 ask);
    event OddsDelisted(uint256 indexed listingId);
    event OddsRequested(uint256 indexed requestId, uint256 indexed listingId, address indexed buyer, uint16 qBps, uint256 stake);
    event OddsSettled(uint256 indexed requestId, uint256 indexed listingId, address indexed buyer, bool won);
    event OddsRefunded(uint256 indexed requestId);

    constructor(IERC20 quote_, CollectionRegistry registry_, IRandomnessProvider randomness_, address treasury_) {
        quote = quote_;
        registry = registry_;
        randomness = randomness_;
        treasury = treasury_;
    }

    function totalAssets() public view override returns (uint256) {
        return quote.balanceOf(address(this)) - pendingEscrow;
    }

    /// @notice Largest ask the vault can currently take on.
    function maxAsk() public view returns (uint256) {
        return (totalAssets() * RISK_BPS) / (10_000 + SELLER_BONUS_BPS);
    }

    function list(address nft, uint256 tokenId, uint128 ask) external nonReentrant returns (uint256 listingId) {
        require(registry.isRegistered(nft), "unregistered");
        require(ask > 0, "ask");
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        listingId = _listings.length;
        _listings.push(OddsListing(msg.sender, nft, tokenId, ask, true, false));
        emit OddsListed(listingId, msg.sender, nft, tokenId, ask);
    }

    function delist(uint256 listingId) external nonReentrant {
        OddsListing storage l = _listings[listingId];
        require(l.seller == msg.sender && l.active && !l.pending, "cannot delist");
        l.active = false;
        IERC721(l.nft).transferFrom(address(this), msg.sender, l.tokenId);
        emit OddsDelisted(listingId);
    }

    /// @notice Total the buyer pays for probability `qBps` of winning listing `listingId`.
    function quoteOdds(uint256 listingId, uint16 qBps) public view returns (uint256 stake, uint256 total) {
        stake = (uint256(_listings[listingId].ask) * qBps) / 10_000;
        total = stake + (stake * (PROTOCOL_FEE_BPS + FRONTEND_FEE_BPS + VAULT_FEE_BPS)) / 10_000;
    }

    function buyOdds(uint256 listingId, uint16 qBps, address frontend) external nonReentrant returns (uint256 requestId) {
        OddsListing storage l = _listings[listingId];
        require(l.active && !l.pending, "unavailable");
        require(qBps >= MIN_Q_BPS && qBps <= MAX_Q_BPS, "odds");
        require(l.ask <= maxAsk(), "vault too small");
        (uint256 stake, uint256 total) = quoteOdds(listingId, qBps);
        require(stake > 0, "stake");
        quote.safeTransferFrom(msg.sender, address(this), total);
        requestId = randomness.requestRandomness();
        require(!requests[requestId].pending, "request id reused");
        requests[requestId] =
            OddsRequest(listingId, msg.sender, frontend, qBps, uint128(stake), uint64(block.timestamp), true);
        l.pending = true;
        pendingEscrow += total;
        emit OddsRequested(requestId, listingId, msg.sender, qBps, stake);
    }

    function fulfillRandomness(uint256 requestId, uint256 randomWord) external override nonReentrant {
        require(msg.sender == address(randomness), "only randomness");
        OddsRequest storage r = requests[requestId];
        if (!r.pending) return;
        r.pending = false;
        OddsListing storage l = _listings[r.listingId];
        l.pending = false;
        uint256 stake = r.stake;
        pendingEscrow -= stake + (stake * (PROTOCOL_FEE_BPS + FRONTEND_FEE_BPS + VAULT_FEE_BPS)) / 10_000;

        quote.safeTransfer(treasury, (stake * PROTOCOL_FEE_BPS) / 10_000);
        quote.safeTransfer(r.frontend == address(0) ? treasury : r.frontend, (stake * FRONTEND_FEE_BPS) / 10_000);

        bool won = randomWord % 10_000 < r.qBps;
        if (won) {
            l.active = false;
            quote.safeTransfer(l.seller, uint256(l.ask) + (uint256(l.ask) * SELLER_BONUS_BPS) / 10_000);
            IERC721(l.nft).transferFrom(address(this), r.buyer, l.tokenId);
        }
        emit OddsSettled(requestId, r.listingId, r.buyer, won);
    }

    function cancelExpired(uint256 requestId) external nonReentrant {
        OddsRequest storage r = requests[requestId];
        require(r.pending && block.timestamp > r.createdAt + REQUEST_TIMEOUT, "not expired");
        r.pending = false;
        _listings[r.listingId].pending = false;
        uint256 stake = r.stake;
        uint256 total = stake + (stake * (PROTOCOL_FEE_BPS + FRONTEND_FEE_BPS + VAULT_FEE_BPS)) / 10_000;
        pendingEscrow -= total;
        quote.safeTransfer(r.buyer, total);
        emit OddsRefunded(requestId);
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function listings(uint256 listingId) external view returns (OddsListing memory) {
        return _listings[listingId];
    }
}
