// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NoRenounce} from "./NoRenounce.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IStakeVault} from "./interfaces/IStakeVault.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SidequestClocks} from "./SidequestClocks.sol";
import {SidequestConstants} from "./interfaces/SidequestConstants.sol";

/// @title StakeVault
/// @notice Delegated SIDE backing and every Sidequest bond (ADR-0014; the full contract is in `IStakeVault`). A bond is a
///         reservation of stake: no token moves when a bond is posted, a slash sends the reserved SIDE to
///         `SidequestConstants.SLASH_SINK` (SIDE has no `burn`), and a Holding
///         can only ever release, slash or forfeit what it reserved itself. Forfeiture transfers SIDE to a recipient.
///         Holdings are authorized behind an immutable timelock
///         longer than the immutable unstake cooldown (production: 21 days > 14 days), and revoked instantly; a revoked Holding still settles its live jobs.
///
///         This contract holds everyone's stake. Its only external calls are to the immutable SIDE token, which has
///         no hooks, and every state-changing entry point is non-reentrant anyway.
contract StakeVault is IStakeVault, NoRenounce, ReentrancyGuardTransient {
    using SafeERC20 for IFactory;
    using SafeCast for uint256;

    uint48 public immutable UNSTAKE_DELAY;
    uint48 public immutable HOLDING_DELAY;
    uint48 public immutable PROPOSAL_GRACE;

    IFactory public immutable factory;

    uint256 public totalAssets;
    uint256 public totalReserved;
    bool public bootstrapped;
    mapping(address holding => bool) public isHolding;
    mapping(address holding => mapping(address account => uint256)) public reservedBy;

    mapping(address account => Pool) internal _pools;
    mapping(address account => mapping(address delegator => Position)) internal _positions;
    mapping(address account => mapping(address holding => bool)) public holdingDenied;
    address internal _pendingHolding;
    uint48 internal _pendingEta;

    constructor(IFactory factory_, SidequestClocks.Config memory clocks) Ownable(msg.sender) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        SidequestClocks.validate(clocks);
        UNSTAKE_DELAY = clocks.unstakeDelay;
        HOLDING_DELAY = clocks.holdingDelay;
        PROPOSAL_GRACE = clocks.proposalGrace;
        factory = factory_;
    }

    // ---------------------------------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------------------------------

    function delegate(address account, uint256 amount) external nonReentrant {
        _delegate(msg.sender, account, msg.sender, amount);
    }

    function delegateWithPermit(address account, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        // A permit submitted by a front-runner leaves the allowance in place; the transfer decides.
        try factory.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _delegate(msg.sender, account, msg.sender, amount);
    }

    function delegateFor(address account, address delegator, uint256 amount) external nonReentrant {
        _delegate(msg.sender, account, delegator, amount);
    }

    function requestUndelegate(address account, uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroShares();
        Pool storage pool = _pools[account];
        Position storage position = _position(account, msg.sender);
        uint256 available = position.shares - position.queuedShares;
        if (shares > available) revert InsufficientShares(available, shares);
        uint256 assets = convertToAssets(account, shares);
        position.queuedShares = (uint256(position.queuedShares) + shares).toUint192();
        pool.queuedShares = (uint256(pool.queuedShares) + shares).toUint192();
        position.unlockAt = (block.timestamp + UNSTAKE_DELAY).toUint48();
        emit UndelegateRequested(account, msg.sender, shares, assets, position.queuedShares, position.unlockAt);
    }

    function cancelUndelegate(address account) external nonReentrant {
        Position storage position = _position(account, msg.sender);
        uint256 shares = position.queuedShares;
        if (shares == 0) revert NothingQueued();
        _pools[account].queuedShares -= uint192(shares);
        position.queuedShares = 0;
        position.unlockAt = 0;
        emit UndelegateCancelled(account, msg.sender, shares, convertToAssets(account, shares));
    }

    function withdraw(address account) external nonReentrant {
        Pool storage pool = _pools[account];
        Position storage position = _position(account, msg.sender);
        uint256 shares = position.queuedShares;
        if (shares == 0) revert NothingQueued();
        if (block.timestamp < position.unlockAt) revert UndelegateLocked(position.unlockAt);
        uint256 assets = convertToAssets(account, shares);
        uint256 remaining = uint256(pool.assets) - assets;
        if (remaining < pool.reserved) revert StillBonded(remaining, pool.reserved);
        pool.assets = remaining.toUint128();
        pool.shares -= shares;
        pool.queuedShares -= uint192(shares);
        position.shares -= shares;
        position.queuedShares = 0;
        position.unlockAt = 0;
        totalAssets -= assets;
        factory.safeTransfer(msg.sender, assets);
        emit Withdrawn(account, msg.sender, shares, assets);
    }

    // ---------------------------------------------------------------------------------------------
    // Bonds
    // ---------------------------------------------------------------------------------------------

    function reserve(address account, uint256 amount) external nonReentrant {
        if (!isHolding[msg.sender]) revert NotHolding();
        if (amount == 0) return;
        if (holdingDenied[account][msg.sender]) revert HoldingDenied();
        Pool storage pool = _pools[account];
        uint256 available = availableOf(account);
        if (amount > available) revert InsufficientAvailable(available, amount);
        pool.reserved = (uint256(pool.reserved) + amount).toUint128();
        reservedBy[msg.sender][account] += amount;
        totalReserved += amount;
        emit Reserved(msg.sender, account, amount);
    }

    function release(address account, uint256 amount) external nonReentrant returns (uint256 released) {
        released = _unreserve(account, amount);
        if (released == 0) return 0;
        emit Released(msg.sender, account, released);
    }

    function slash(address account, uint256 amount) external nonReentrant returns (uint256 burned) {
        burned = _unreserve(account, amount);
        if (burned == 0) return 0;
        Pool storage pool = _pools[account];
        pool.assets -= uint128(burned);
        totalAssets -= burned;
        factory.safeTransfer(SidequestConstants.SLASH_SINK, burned);
        emit Slashed(msg.sender, account, burned);
        if (pool.assets == 0) {
            pool.shares = 0;
            pool.queuedShares = 0;
            ++pool.generation;
            emit PoolReset(account, pool.generation);
        }
    }

    function forfeit(address account, uint256 amount, address to) external nonReentrant returns (uint256 taken) {
        if (to == address(0)) revert ZeroAddress();
        taken = _unreserve(account, amount);
        if (taken == 0) return 0;
        Pool storage pool = _pools[account];
        pool.assets -= uint128(taken);
        totalAssets -= taken;
        factory.safeTransfer(to, taken);
        emit Forfeited(msg.sender, account, to, taken);
        if (pool.assets == 0) {
            pool.shares = 0;
            pool.queuedShares = 0;
            ++pool.generation;
            emit PoolReset(account, pool.generation);
        }
    }

    function setHoldingDenied(address holding, bool denied) external {
        holdingDenied[msg.sender][holding] = denied;
        emit HoldingDeniedSet(msg.sender, holding, denied);
    }

    // ---------------------------------------------------------------------------------------------
    // Holding authorization
    // ---------------------------------------------------------------------------------------------

    function proposeHolding(address holding) external onlyOwner {
        if (holding == address(0)) revert ZeroAddress();
        if (isHolding[holding]) revert HoldingAlreadyAuthorized();
        _dropProposal();
        uint48 eta = uint48(block.timestamp) + HOLDING_DELAY;
        _pendingHolding = holding;
        _pendingEta = eta;
        emit HoldingProposed(holding, eta);
    }

    function cancelHoldingProposal() external onlyOwner {
        if (_pendingHolding == address(0)) revert NoHoldingProposed();
        _dropProposal();
    }

    function acceptHolding() external {
        address holding = _pendingHolding;
        if (holding == address(0)) revert NoHoldingProposed();
        uint48 eta = _pendingEta;
        if (block.timestamp < eta) revert HoldingTimelocked(eta);
        if (block.timestamp > uint256(eta) + PROPOSAL_GRACE) revert HoldingProposalExpired();
        delete _pendingHolding;
        delete _pendingEta;
        isHolding[holding] = true;
        bootstrapped = true;
        emit HoldingAuthorized(holding, false);
    }

    function revokeHolding(address holding) external onlyOwner {
        if (!isHolding[holding]) revert NotHolding();
        isHolding[holding] = false;
        if (_pendingHolding == holding) _dropProposal();
        emit HoldingRevoked(holding);
    }

    /// @dev Staking is closed until this (or `acceptHolding`) runs, so nobody can stake first and force the launch onto
    ///      the timelocked admission path; `totalAssets == 0` is kept as a second guard.
    function bootstrapHolding(address holding) external onlyOwner {
        if (bootstrapped || totalAssets != 0 || _pendingHolding != address(0)) revert BootstrapClosed();
        if (holding == address(0)) revert ZeroAddress();
        bootstrapped = true;
        isHolding[holding] = true;
        emit HoldingAuthorized(holding, true);
    }

    /// @dev A proposal never outlives its proposer (C9 ACL-3): the deployer's, say, is dropped when the Safe accepts.
    function _transferOwnership(address newOwner) internal override {
        _dropProposal();
        super._transferOwnership(newOwner);
    }

    function _dropProposal() private {
        address holding = _pendingHolding;
        if (holding == address(0)) return;
        delete _pendingHolding;
        delete _pendingEta;
        emit HoldingProposalCancelled(holding);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function stakeOf(address account) public view returns (uint256) {
        Pool memory pool = _pools[account];
        if (pool.shares == 0) return 0;
        return Math.mulDiv(pool.shares - pool.queuedShares, pool.assets, pool.shares);
    }

    function reservedOf(address account) external view returns (uint256) {
        return _pools[account].reserved;
    }

    function availableOf(address account) public view returns (uint256) {
        uint256 active = stakeOf(account);
        uint256 reserved = _pools[account].reserved;
        return active > reserved ? active - reserved : 0;
    }

    function poolOf(address account) external view returns (Pool memory) {
        return _pools[account];
    }

    function positionOf(address account, address delegator) external view returns (Position memory position) {
        position = _positions[account][delegator];
        uint64 generation = _pools[account].generation;
        if (position.generation != generation) return Position(0, 0, 0, generation);
    }

    function convertToAssets(address account, uint256 shares) public view returns (uint256) {
        Pool memory pool = _pools[account];
        if (pool.shares == 0) return 0;
        return Math.mulDiv(shares, pool.assets, pool.shares);
    }

    function convertToShares(address account, uint256 assets) public view returns (uint256) {
        Pool memory pool = _pools[account];
        if (pool.shares == 0) return assets;
        return Math.mulDiv(assets, pool.shares, pool.assets);
    }

    function pendingHolding() external view returns (address holding, uint48 eta) {
        return (_pendingHolding, _pendingEta);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _delegate(address payer, address account, address delegator, uint256 assets) private {
        if (!bootstrapped) revert NotBootstrapped();
        if (account == address(0) || delegator == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        uint256 shares = convertToShares(account, assets);
        if (shares == 0) revert ZeroShares();
        Pool storage pool = _pools[account];
        Position storage position = _position(account, delegator);
        // Queued shares are uint192 so every accepted position can be exited in one cooldown. Reject a
        // price-inflating deposit before taking tokens; an empty pool recovers to a 1:1 price after exit.
        uint256 newShares = (pool.shares + shares).toUint192();
        pool.assets = (uint256(pool.assets) + assets).toUint128();
        pool.shares = newShares;
        position.shares += shares;
        totalAssets += assets;
        factory.safeTransferFrom(payer, address(this), assets);
        emit Delegated(account, delegator, payer, assets, shares);
    }

    /// @dev Clear a wiped-out position only when touched; the reset event invalidates every old position at once.
    function _position(address account, address delegator) private returns (Position storage position) {
        position = _positions[account][delegator];
        uint64 generation = _pools[account].generation;
        if (position.generation != generation) {
            delete _positions[account][delegator];
            position.generation = generation;
        }
    }

    /// @dev Removes up to `amount` of the caller's own reservation on `account`. Capped rather than reverting, so a
    ///      Holding's settlement can never be blocked here.
    function _unreserve(address account, uint256 amount) private returns (uint256 taken) {
        uint256 mine = reservedBy[msg.sender][account];
        taken = amount < mine ? amount : mine;
        if (taken == 0) return 0;
        reservedBy[msg.sender][account] = mine - taken;
        _pools[account].reserved -= uint128(taken);
        totalReserved -= taken;
    }
}
