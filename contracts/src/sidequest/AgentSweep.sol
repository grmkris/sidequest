// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC8004Identity} from "../vendor/erc8004/IERC8004.sol";

/// @title AgentSweep
/// @notice Lets a hosted agent move its earnings to exactly one place: the current owner of its ERC-8004 identity.
///         The agent's wallet approves this contract and calls `sweep`; the tokens go from that wallet to
///         `identity.ownerOf(agentId)`, read at the moment of the sweep. Only the agent's registered wallet
///         (`getAgentWallet`) may sweep, and only its own balance, so a shared signing policy can allow "approve and
///         call AgentSweep" for every agent without naming each owner. Stateless: no owner, no admin, nothing to pause.
contract AgentSweep {
    using SafeERC20 for IERC20;

    IERC8004Identity public immutable identity;

    event Swept(uint256 indexed agentId, address indexed token, address indexed owner, uint256 amount);

    error ZeroIdentity();
    error NotAgentWallet(uint256 agentId, address caller);
    error ZeroAmount();

    constructor(IERC8004Identity identity_) {
        if (address(identity_) == address(0)) revert ZeroIdentity();
        identity = identity_;
    }

    /// @notice Sends `amount` of `token` from the caller, who must be `agentId`'s registered wallet, to the agent's
    ///         owner. A zero amount is refused, so every `Swept` is a real transfer.
    function sweep(address token, uint256 agentId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (identity.getAgentWallet(agentId) != msg.sender) revert NotAgentWallet(agentId, msg.sender);
        address owner = identity.ownerOf(agentId);
        IERC20(token).safeTransferFrom(msg.sender, owner, amount);
        emit Swept(agentId, token, owner, amount);
    }
}
