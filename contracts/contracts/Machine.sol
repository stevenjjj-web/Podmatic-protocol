// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReserveVault} from "./ReserveVault.sol";
import {CollectionRegistry} from "./CollectionRegistry.sol";
import {BidBook} from "./BidBook.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomness.sol";

/// @title Machine
/// @notice A blind-draw machine for one NFT collection.
/// @dev Pricing (see docs/podmatic-pricing.md):
///      - Holders consign NFTs with a floor price only. They never quote a sale price.
///      - An NFT's value V is the price of a resting, funded collection or trait bid in the BidBook. Anyone can refresh
///        a listing with a higher eligible bid. The NFT is drawable when V * (1 + premium) >= the holder's floor.
///      - On a draw the machine earmarks that bid for the exit window, so the winner can always sell the NFT for V.
///      - The seller receives V * (1 + premium) minus the pricing fee, which goes to the bidder who priced the NFT.
///      Odds: the creator sets tier bands, base probabilities and a target return. Each draw re-solves the probabilities
///      so the expected value equals the target, tilting toward the highest or lowest drawable tier (RTP lock).
///      Reserve: LPs fund payouts. A tier is drawable only if its maximum settlement fits within `riskBps` of the reserve.
contract Machine is ReserveVault, IRandomnessConsumer {
    using SafeERC20 for IERC20;

    struct Tier {
        uint128 minValue;
        uint128 maxValue;
        uint16 baseProbBps;
    }

    struct Init {
        address nft;
        uint128 spinPrice;
        uint16 targetRtpBps;
        uint16 creatorFeeBps;
        uint16 riskBps;
        Tier[] tiers;
        string name;
    }

    struct Deps {
        address creator;
        address factory;
        address treasury;
        IERC20 quote;
        CollectionRegistry registry;
        BidBook bidBook;
        IRandomnessProvider randomness;
    }

    enum Status {
        None,
        Idle, // consigned, not drawable (no eligible bid, out of range, or no tier fits)
        Active, // drawable
        Sold,
        Delisted
    }

    struct Listing {
        address seller;
        uint256 tokenId;
        uint128 floorPrice;
        uint128 value;
        bytes32 traitKey;
        uint256 bidId;
        uint8 tier;
        uint32 tierIndex;
        Status status;
    }

    struct SpinRequest {
        address player;
        address frontend;
        uint64 createdAt;
        bool pending;
    }

    struct Odds {
        bool open;
        uint256 goal;
        uint256[5] probs; // 1e18 = 100%
        uint256[5] evs;
        bool[5] live;
    }

    uint16 public constant PROTOCOL_FEE_BPS = 150;
    uint16 public constant FRONTEND_FEE_BPS = 100;
    uint16 public constant MAX_CREATOR_FEE_BPS = 300;
    uint16 public constant PREMIUM_BPS = 300; // seller settlement premium over V
    uint16 public constant PRICING_FEE_BPS = 50; // part of the premium paid to the bidder whose bid priced the NFT
    uint16 public constant MIN_RTP_BPS = 8_500;
    uint16 public constant MAX_RTP_BPS = 9_700;
    uint16 public constant MIN_RISK_BPS = 500;
    uint16 public constant MAX_RISK_BPS = 2_500;
    uint64 public constant EXIT_WINDOW = 3 days;
    uint64 public constant SPIN_TIMEOUT = 1 days;
    uint256 public constant MAX_TIERS = 5;
    uint256 public constant NO_BID = type(uint256).max;
    uint256 internal constant ONE = 1e18;
    uint256 internal constant ATTEMPTS = 3;

    bool public initialized;
    address public creator;
    address public factory;
    address public treasury;
    CollectionRegistry public registry;
    BidBook public bidBook;
    IRandomnessProvider public randomness;

    string public name;
    address public nft;
    uint128 public spinPrice;
    uint16 public targetRtpBps;
    uint16 public creatorFeeBps;
    uint16 public riskBps;

    Tier[] internal _tiers;
    uint256[][5] internal _tierListings;
    uint256[5] public tierSum;

    Listing[] internal _listings;
    mapping(uint256 requestId => SpinRequest) public spins;
    uint256 public pendingSpins;
    uint256 public pendingEscrow;

    event Listed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId, uint256 floorPrice, bytes32 traitKey);
    event ValuationUpdated(uint256 indexed listingId, uint256 bidId, uint256 value, uint8 tier, bool active);
    event Delisted(uint256 indexed listingId);
    event SpinRequested(uint256 indexed requestId, address indexed player);
    event SpinSettled(
        uint256 indexed requestId,
        address indexed player,
        uint256 indexed listingId,
        uint256 tokenId,
        uint8 tier,
        uint256 value,
        uint256 earmarkId
    );
    event SpinRefunded(uint256 indexed requestId, address indexed player);

    function initialize(Init calldata p, Deps calldata d) external {
        require(!initialized, "initialized");
        initialized = true;

        require(p.targetRtpBps >= MIN_RTP_BPS && p.targetRtpBps <= MAX_RTP_BPS, "rtp");
        require(p.creatorFeeBps <= MAX_CREATOR_FEE_BPS, "creator fee");
        require(p.riskBps >= MIN_RISK_BPS && p.riskBps <= MAX_RISK_BPS, "risk");
        require(p.spinPrice > 0, "price");
        uint256 n = p.tiers.length;
        require(n >= 2 && n <= MAX_TIERS, "tiers");
        uint256 probSum;
        for (uint256 i; i < n; ++i) {
            Tier calldata t = p.tiers[i];
            require(t.minValue > 0 && t.minValue < t.maxValue, "band");
            // Keeps tier labels meaningful: the top tier may span 5x, others 3x.
            require(t.maxValue <= uint256(t.minValue) * (i == n - 1 ? 5 : 3), "band too wide");
            if (i > 0) require(t.minValue >= p.tiers[i - 1].maxValue, "overlap");
            require(t.baseProbBps > 0, "prob");
            probSum += t.baseProbBps;
            _tiers.push(t);
        }
        require(probSum == 10_000, "probs");
        require(uint256(p.tiers[0].minValue) * 5 >= p.spinPrice, "floor prize too small");
        require(p.tiers[n - 1].maxValue <= uint256(p.spinPrice) * 60, "top prize too large");

        name = p.name;
        nft = p.nft;
        spinPrice = p.spinPrice;
        targetRtpBps = p.targetRtpBps;
        creatorFeeBps = p.creatorFeeBps;
        riskBps = p.riskBps;

        creator = d.creator;
        factory = d.factory;
        treasury = d.treasury;
        quote = d.quote;
        registry = d.registry;
        bidBook = d.bidBook;
        randomness = d.randomness;
    }

    // ------------------------------------------------------------------ reserve

    function totalAssets() public view override returns (uint256) {
        return quote.balanceOf(address(this)) - pendingEscrow;
    }

    // ------------------------------------------------------------------ consignment

    /// @notice Consign an NFT with the lowest price you accept. Prove the trait you want it valued by (0 = collection).
    function list(uint256 tokenId, uint128 floorPrice, bytes32 traitKey, bytes32[] calldata proof)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        require(registry.verifyTrait(nft, tokenId, traitKey, proof), "trait proof");
        require(registry.isValuationTrait(nft, traitKey), "trait too rare");
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        listingId = _listings.length;
        _listings.push(Listing(msg.sender, tokenId, floorPrice, 0, traitKey, NO_BID, 0, 0, Status.Idle));
        emit Listed(listingId, msg.sender, tokenId, floorPrice, traitKey);
    }

    /// @notice Value a listing with a bid. Anyone may call. A new bid must be at least as high as the current one,
    ///         unless the current bid can no longer back the valuation. Pass NO_BID to drop a stale valuation.
    function refreshValuation(uint256 listingId, uint256 bidId) external {
        require(pendingSpins == 0, "spins pending");
        Listing storage l = _listings[listingId];
        require(l.status == Status.Idle || l.status == Status.Active, "closed");
        bool currentValid = l.bidId != NO_BID && bidBook.isValuationEligible(l.bidId, nft, l.traitKey);

        if (bidId == NO_BID) {
            require(!currentValid, "current bid valid");
            _deactivate(listingId);
            l.value = 0;
            l.bidId = NO_BID;
            emit ValuationUpdated(listingId, NO_BID, 0, 0, false);
            return;
        }

        require(bidBook.isValuationEligible(bidId, nft, l.traitKey), "bid not eligible");
        uint128 price = bidBook.bids(bidId).price;
        if (currentValid && bidId != l.bidId) require(price >= l.value, "lower bid");

        _deactivate(listingId);
        l.value = price;
        l.bidId = bidId;
        (bool found, uint8 tier) = _tierFor(price);
        bool inRange = (uint256(price) * (10_000 + PREMIUM_BPS)) / 10_000 >= l.floorPrice;
        if (found && inRange) _activate(listingId, tier);
        emit ValuationUpdated(listingId, bidId, price, tier, l.status == Status.Active);
    }

    function delist(uint256 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.seller == msg.sender, "not seller");
        require(l.status == Status.Idle || l.status == Status.Active, "closed");
        if (l.status == Status.Active) require(pendingSpins == 0, "spins pending");
        _deactivate(listingId);
        l.status = Status.Delisted;
        IERC721(nft).transferFrom(address(this), msg.sender, l.tokenId);
        emit Delisted(listingId);
    }

    // ------------------------------------------------------------------ draws

    function spin(address frontend) external nonReentrant returns (uint256 requestId) {
        require(previewOdds().open, "machine closed");
        uint256 price = spinPrice;
        quote.safeTransferFrom(msg.sender, address(this), price);
        requestId = randomness.requestRandomness();
        require(!spins[requestId].pending, "request id reused");
        spins[requestId] = SpinRequest(msg.sender, frontend, uint64(block.timestamp), true);
        pendingSpins += 1;
        pendingEscrow += price;
        emit SpinRequested(requestId, msg.sender);
    }

    function fulfillRandomness(uint256 requestId, uint256 randomWord) external override nonReentrant {
        require(msg.sender == address(randomness), "only randomness");
        SpinRequest memory s = spins[requestId];
        if (!s.pending) return;
        spins[requestId].pending = false;
        pendingSpins -= 1;
        pendingEscrow -= spinPrice;

        uint256 fees = _spinFees();
        for (uint256 attempt; attempt < ATTEMPTS; ++attempt) {
            Odds memory o = _odds(totalAssets() - fees);
            if (!o.open) break;
            uint256 r = uint256(keccak256(abi.encode(randomWord, attempt)));
            uint8 tier = _pickTier(o.probs, r % ONE);
            uint256[] storage pool = _tierListings[tier];
            uint256 listingId = pool[(r / ONE) % pool.length];
            if (_trySettle(requestId, s, listingId)) return;
        }
        quote.safeTransfer(s.player, spinPrice);
        emit SpinRefunded(requestId, s.player);
    }

    /// @notice Refund a spin whose randomness never arrived.
    function cancelExpiredSpin(uint256 requestId) external nonReentrant {
        SpinRequest storage s = spins[requestId];
        require(s.pending && block.timestamp > s.createdAt + SPIN_TIMEOUT, "not expired");
        s.pending = false;
        pendingSpins -= 1;
        pendingEscrow -= spinPrice;
        quote.safeTransfer(s.player, spinPrice);
        emit SpinRefunded(requestId, s.player);
    }

    /// @notice Odds for the next spin, computed as if it were paid now.
    function previewOdds() public view returns (Odds memory) {
        return _odds(totalAssets() + spinPrice - _spinFees());
    }

    // ------------------------------------------------------------------ views

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tiers(uint256 i) external view returns (Tier memory) {
        return _tiers[i];
    }

    function tierListings(uint256 i) external view returns (uint256[] memory) {
        return _tierListings[i];
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function listings(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    // ------------------------------------------------------------------ internals

    function _spinFees() internal view returns (uint256) {
        return (uint256(spinPrice) * (PROTOCOL_FEE_BPS + FRONTEND_FEE_BPS + creatorFeeBps)) / 10_000;
    }

    function _trySettle(uint256 requestId, SpinRequest memory s, uint256 listingId) internal returns (bool) {
        Listing storage l = _listings[listingId];
        // The bid may have changed since the listing was valued; a stale valuation is dropped and we redraw.
        if (bidBook.bids(l.bidId).price != l.value) {
            _deactivate(listingId);
            return false;
        }
        uint256 earmarkId;
        address bidder;
        try bidBook.earmark(l.bidId, l.traitKey, l.tokenId, uint64(block.timestamp) + EXIT_WINDOW) returns (
            uint256 id, address b, uint256
        ) {
            earmarkId = id;
            bidder = b;
        } catch {
            _deactivate(listingId);
            return false;
        }

        uint8 tier = l.tier;
        uint256 v = l.value;
        _deactivate(listingId);
        l.status = Status.Sold;

        uint256 settlement = (v * (10_000 + PREMIUM_BPS)) / 10_000;
        uint256 pricingFee = (v * PRICING_FEE_BPS) / 10_000;
        quote.safeTransfer(l.seller, settlement - pricingFee);
        quote.safeTransfer(bidder, pricingFee);
        _payFees(s.frontend);
        IERC721(nft).transferFrom(address(this), s.player, l.tokenId);
        emit SpinSettled(requestId, s.player, listingId, l.tokenId, tier, v, earmarkId);
        return true;
    }

    function _payFees(address frontend) internal {
        uint256 price = spinPrice;
        quote.safeTransfer(treasury, (price * PROTOCOL_FEE_BPS) / 10_000);
        quote.safeTransfer(frontend == address(0) ? treasury : frontend, (price * FRONTEND_FEE_BPS) / 10_000);
        if (creatorFeeBps > 0) quote.safeTransfer(creator, (price * creatorFeeBps) / 10_000);
    }

    /// @dev RTP lock. Live tiers: non-empty and whose largest settlement fits within riskBps of `avail`.
    ///      Open if at least two tiers are live, the cheapest live tier is at or below the target and the richest is at
    ///      or above the 85% floor. The target becomes min(target, richest live tier) and the base odds are tilted so the
    ///      expected value equals it.
    function _odds(uint256 avail) internal view returns (Odds memory o) {
        uint256 n = _tiers.length;
        uint256 cap = (avail * riskBps) / 10_000;
        uint256 weight;
        uint256 liveCount;
        uint256 low = type(uint256).max;
        uint256 top;
        for (uint256 k; k < n; ++k) {
            uint256 count = _tierListings[k].length;
            if (count == 0) continue;
            if ((uint256(_tiers[k].maxValue) * (10_000 + PREMIUM_BPS)) / 10_000 > cap) continue;
            o.live[k] = true;
            o.evs[k] = tierSum[k] / count;
            weight += _tiers[k].baseProbBps;
            liveCount += 1;
            if (low == type(uint256).max) low = k;
            top = k;
        }
        if (liveCount < 2) return o;

        uint256 target = (uint256(spinPrice) * targetRtpBps) / 10_000;
        uint256 floorEv = (uint256(spinPrice) * MIN_RTP_BPS) / 10_000;
        if (o.evs[low] > target || o.evs[top] < floorEv) return o;
        o.goal = o.evs[top] < target ? o.evs[top] : target;

        uint256 e;
        for (uint256 k; k < n; ++k) {
            if (!o.live[k]) continue;
            o.probs[k] = (uint256(_tiers[k].baseProbBps) * ONE) / weight;
            e += o.probs[k] * o.evs[k];
        }
        e /= ONE;
        if (e < o.goal) {
            uint256 t = ((o.goal - e) * ONE) / (o.evs[top] - e);
            _tilt(o.probs, n, t, top);
        } else if (e > o.goal) {
            uint256 t = ((e - o.goal) * ONE) / (e - o.evs[low]);
            _tilt(o.probs, n, t, low);
        }
        o.open = true;
    }

    function _tilt(uint256[5] memory probs, uint256 n, uint256 t, uint256 toward) internal pure {
        for (uint256 k; k < n; ++k) {
            probs[k] = (probs[k] * (ONE - t)) / ONE;
        }
        probs[toward] += t;
    }

    function _pickTier(uint256[5] memory probs, uint256 r) internal view returns (uint8) {
        uint256 n = _tiers.length;
        uint256 acc;
        uint8 last;
        for (uint256 k; k < n; ++k) {
            if (probs[k] == 0) continue;
            acc += probs[k];
            last = uint8(k);
            if (r < acc) return uint8(k);
        }
        return last; // rounding dust
    }

    function _tierFor(uint256 value) internal view returns (bool, uint8) {
        for (uint256 k; k < _tiers.length; ++k) {
            if (value >= _tiers[k].minValue && value <= _tiers[k].maxValue) return (true, uint8(k));
        }
        return (false, 0);
    }

    function _activate(uint256 listingId, uint8 tier) internal {
        Listing storage l = _listings[listingId];
        l.tier = tier;
        l.tierIndex = uint32(_tierListings[tier].length);
        l.status = Status.Active;
        _tierListings[tier].push(listingId);
        tierSum[tier] += l.value;
    }

    function _deactivate(uint256 listingId) internal {
        Listing storage l = _listings[listingId];
        if (l.status != Status.Active) return;
        uint256[] storage pool = _tierListings[l.tier];
        uint256 lastId = pool[pool.length - 1];
        pool[l.tierIndex] = lastId;
        _listings[lastId].tierIndex = l.tierIndex;
        pool.pop();
        tierSum[l.tier] -= l.value;
        l.status = Status.Idle;
    }
}
