// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title IFactory
/// @notice SIDE as the protocol uses it: a plain ERC-20 with 18 decimals and EIP-2612 `permit`, created outside the
///         protocol (on mainnet, by the nad.fun launcher). The protocol needs nothing else from it: no `burn`, no
///         owner, no hooks. The staking vault sends slashed bonds to `SidequestConstants.SLASH_SINK` instead of burning.
interface IFactory is IERC20Metadata, IERC20Permit {}
