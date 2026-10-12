// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFactory} from "./IFactory.sol";

/// @title IStakeVault
/// @notice Delegated SIDE backing and Sidequest bond reservations (ADR-0014). Each account has one share pool;
///         each delegator owns its position, even when another payer funds it. Active backing, including reservations,
///         sets the fee tier. Queued shares stop counting for tiers and new bonds but remain slashable pro-rata.
///
///         Requests are allowed while bonded and restart the cooldown for the entire position's queue. Withdrawal pays
///         the delegator after the cooldown only if the remaining pool assets cover all reservations (`StillBonded`).
///         A full slash resets the pool generation; older positions read as zero and are cleared lazily.
///
///         Only authorized Holdings reserve, subject to the account's veto. Revoked Holdings can still release and
///         slash their own reservations (`reservedBy`). The Safe proposes Holdings behind a delay longer than the
///         withdrawal cooldown and can revoke instantly. Delegation stays closed until bootstrap or first acceptance.
///
///         Invariants: `pool.reserved <= pool.assets`; `totalReserved <= totalAssets`; the vault's SIDE balance is
///         at least `totalAssets`, which includes queued assets. Reservations may exceed active `stakeOf` after an exit
///         request, so `availableOf` saturates at zero. Direct token transfers do not change share prices or accounting.
///         There is no aggregate queued-assets view: use each pool's shares to value its queue after slashes.
///
///         The implementation is Ownable2Step; its ownership functions come from OpenZeppelin.
interface IStakeVault {
    struct Pool {
        uint128 assets;
        uint128 reserved;
        uint256 shares;
        uint192 queuedShares;
        uint64 generation;
    }

    /// @dev `shares` includes `queuedShares`; both belong to this generation only.
    struct Position {
        uint256 shares;
        uint192 queuedShares;
        uint48 unlockAt;
        uint64 generation;
    }

    event Delegated(
        address indexed account, address indexed delegator, address indexed payer, uint256 assets, uint256 shares
    );
    event UndelegateRequested(
        address indexed account,
        address indexed delegator,
        uint256 shares,
        uint256 assets,
        uint256 queuedShares,
        uint48 unlockAt
    );
    event UndelegateCancelled(address indexed account, address indexed delegator, uint256 shares, uint256 assets);
    event Withdrawn(address indexed account, address indexed delegator, uint256 shares, uint256 assets);
    event PoolReset(address indexed account, uint64 generation);
    event Reserved(address indexed holding, address indexed account, uint256 amount);
    event Released(address indexed holding, address indexed account, uint256 amount);
    /// @dev The slashed SIDE moves to the current `slashRecipient` in the same call.
    event Slashed(address indexed holding, address indexed account, uint256 amount);
    event SlashRecipientSet(address indexed previous, address indexed recipient);
    /// @dev The forfeited SIDE is transferred to the supplied treasury recipient.
    event Forfeited(address indexed holding, address indexed account, address indexed to, uint256 amount);
    event HoldingProposed(address indexed holding, uint48 eta);
    event HoldingProposalCancelled(address indexed holding);
    event HoldingAuthorized(address indexed holding, bool bootstrap);
    event HoldingRevoked(address indexed holding);
    event HoldingDeniedSet(address indexed account, address indexed holding, bool denied);

    error ZeroAmount();
    error ZeroAddress();
    /// @dev Slashed SIDE cannot return to this vault outside its asset accounting.
    error InvalidSlashRecipient();
    /// @dev Only active backing above existing reservations can be reserved.
    error InsufficientAvailable(uint256 available, uint256 requested);
    error NotHolding();
    error ZeroShares();
    error InsufficientShares(uint256 available, uint256 requested);
    error NothingQueued();
    error UndelegateLocked(uint48 unlockAt);
    error StillBonded(uint256 remaining, uint256 reserved);
    error NoHoldingProposed();
    error HoldingTimelocked(uint48 eta);
    error HoldingAlreadyAuthorized();
    error BootstrapClosed();
    /// @dev Staking opens when the first Holding is authorized.
    error NotBootstrapped();
    /// @dev The account vetoed this Holding (`setHoldingDenied`).
    error HoldingDenied();
    /// @dev The proposal's acceptance window (`PROPOSAL_GRACE` after its eta) has passed.
    error HoldingProposalExpired();

    // ---------------------------------------------------------------------------------------------
    // Delegation
    // ---------------------------------------------------------------------------------------------

    /// @notice The caller pays `amount` and owns the shares backing `account`. The first deposit mints 1:1;
    ///         subsequent deposits round shares down in favour of the pool and revert if they would mint zero.
    function delegate(address account, uint256 amount) external;

    /// @notice Delegates with an EIP-2612 permit from the caller. A permit already submitted by a front-runner is
    ///         tolerated if its allowance remains sufficient. A relay cannot use an EOA's permit as its own position.
    function delegateWithPermit(address account, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    /// @notice The caller pays; `delegator` owns the shares backing `account`. The Safe backs agents with `(agent, safe)`.
    function delegateFor(address account, address delegator, uint256 amount) external;

    /// @notice Queues `shares` from the caller's position, even while bonded, and restarts the entire queue's cooldown.
    ///         Queued shares remain slashable but stop counting for the tier and new bonds immediately.
    function requestUndelegate(address account, uint256 shares) external;

    /// @notice Restores all of the caller's queued shares to active backing, without changing their slash exposure.
    function cancelUndelegate(address account) external;

    /// @notice Redeems the caller's whole queue after unlock, rounding assets down; the last shares receive all assets.
    ///         Reverts `StillBonded(remaining, reserved)` if withdrawal would leave any existing bond undercollateralized.
    function withdraw(address account) external;

    // ---------------------------------------------------------------------------------------------
    // Bonds (Holdings only)
    // ---------------------------------------------------------------------------------------------

    /// @notice An authorized Holding reserves `amount` of `account`'s unreserved stake as a bond. A zero amount
    ///         reserves nothing but still requires the caller to be authorized, so a revoked Holding stops publishing.
    ///         Refused for a Holding the account has denied.
    function reserve(address account, uint256 amount) external;

    /// @notice The caller vetoes (or re-allows) `holding` taking new bonds from its stake (C9 ACL-1). The 21-day delay
    ///         lets free stake leave before a new Holding goes live; this protects stake that is still bonded when
    ///         the Holding arrives and is released later. Existing reservations still release and slash.
    function setHoldingDenied(address holding, bool denied) external;

    /// @notice Whether `account` has denied `holding`.
    function holdingDenied(address account, address holding) external view returns (bool);

    /// @notice Releases up to `amount` of the reservation the caller holds on `account` (any Holding, revoked or not).
    /// @return released The amount released: `min(amount, reservedBy(caller, account))`.
    function release(address account, uint256 amount) external returns (uint256 released);

    /// @notice Slashes up to `amount` of the reservation the caller holds on `account` and sends it to
    ///         the current `slashRecipient` (the treasury at launch).
    /// @return burned The amount slashed: `min(amount, reservedBy(caller, account))`.
    function slash(address account, uint256 amount) external returns (uint256 burned);

    /// @notice Removes up to `amount` from this Holding's reservation and transfers it to `to`.
    function forfeit(address account, uint256 amount, address to) external returns (uint256 taken);

    // ---------------------------------------------------------------------------------------------
    // Holding authorization (owner = the Safe)
    // ---------------------------------------------------------------------------------------------

    /// @notice Owner only. Proposes `holding`, replacing (and cancelling) any earlier proposal; it can be accepted
    ///         from `HOLDING_DELAY` until `PROPOSAL_GRACE` after that. An ownership transfer drops it.
    function proposeHolding(address holding) external;

    /// @notice Owner only. Drops the pending proposal.
    function cancelHoldingProposal() external;

    /// @notice Anyone, once the delay has passed: authorizes the pending Holding.
    function acceptHolding() external;

    /// @notice Owner only, instant. `holding` can no longer reserve; its existing reservations still release and slash.
    ///         A pending proposal for the same Holding is dropped, so it cannot be re-accepted.
    function revokeHolding(address holding) external;

    /// @notice Owner only, once, and only before any Holding was authorized and while none is proposed: authorizes
    ///         the first Holding without the delay and opens staking.
    function bootstrapHolding(address holding) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function factory() external view returns (IFactory);

    /// @notice Where slashed SIDE is sent; the owner can change it immediately.
    function slashRecipient() external view returns (address);

    /// @notice Owner only. Sets a nonzero recipient other than this vault, emitting `SlashRecipientSet`.
    ///         Routing a penalty does not change its amount or the backer's exposure; no timelock applies.
    function setSlashRecipient(address recipient) external;

    /// @notice Active backing: `floor((shares - queuedShares) * assets / shares)`, or zero for an empty pool.
    function stakeOf(address account) external view returns (uint256);

    /// @notice The part of `account`'s stake that bonds on live jobs hold, over all Holdings.
    function reservedOf(address account) external view returns (uint256);

    /// @notice The part of `account`'s stake that `holding` has reserved.
    function reservedBy(address holding, address account) external view returns (uint256);

    /// @notice `max(stakeOf(account) - reservedOf(account), 0)`: backing available for new bonds.
    function availableOf(address account) external view returns (uint256);

    function poolOf(address account) external view returns (Pool memory);

    /// @notice Older-generation positions return zero shares/queue/unlock, with the pool's current generation.
    function positionOf(address account, address delegator) external view returns (Position memory);

    /// @notice Floors `shares * assets / pool.shares`; empty pools return zero. The last shares receive all assets.
    function convertToAssets(address account, uint256 shares) external view returns (uint256);

    /// @notice Floors `assets * pool.shares / pool.assets`; empty pools quote 1:1.
    function convertToShares(address account, uint256 assets) external view returns (uint256);

    /// @notice Sum of every pool's assets, including the slashable queued backing.
    function totalAssets() external view returns (uint256);
    function totalReserved() external view returns (uint256);

    /// @notice Whether `holding` may reserve stake now.
    function isHolding(address holding) external view returns (bool);

    /// @notice The proposed Holding and when it can be accepted; zero when none.
    function pendingHolding() external view returns (address holding, uint48 eta);

    /// @notice Whether a first Holding has been authorized (by `bootstrapHolding` or `acceptHolding`): staking is open
    ///         and `bootstrapHolding` is closed.
    function bootstrapped() external view returns (bool);

    /// @notice The delegation exit cooldown (14 days in production; deployment clocks on testnet).
    function UNSTAKE_DELAY() external view returns (uint48);

    /// @notice The delay before a proposed Holding can be accepted (15 days).
    function HOLDING_DELAY() external view returns (uint48);

    /// @notice How long after its eta a Holding proposal can still be accepted (7 days).
    function PROPOSAL_GRACE() external view returns (uint48);
}
