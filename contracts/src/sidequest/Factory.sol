// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {SidequestConstants} from "./interfaces/SidequestConstants.sol";

/// @title Factory
/// @notice SIDE v2 (ADR-0011). The whole fixed supply, 1e9 tokens with 18 decimals, is minted once in the
///         constructor to the genesis allocation; there is no owner and no way to mint, pause, block or upgrade, so
///         nobody can ever freeze stake or bonds. `burn` lets the staking vault destroy slashed bonds; `permit`
///         (EIP-2612) saves the holder an `approve` before staking.
contract Factory is ERC20, ERC20Permit, ERC20Burnable, IFactory {
    error LengthMismatch();
    error ZeroRecipient();
    error SupplyMismatch(uint256 total, uint256 expected);

    /// @param recipients The genesis allocation: mining reserve, treasury, team vesting, ecosystem, liquidity.
    /// @param amounts What each recipient gets; the sum must be exactly 1e9 · 1e18.
    constructor(string memory name_, string memory symbol_, address[] memory recipients, uint256[] memory amounts)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        if (recipients.length != amounts.length) revert LengthMismatch();
        uint256 total = 0;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroRecipient();
            total += amounts[i];
            _mint(recipients[i], amounts[i]);
        }
        if (total != SidequestConstants.SIDE_SUPPLY) revert SupplyMismatch(total, SidequestConstants.SIDE_SUPPLY);
    }

    function nonces(address owner) public view override(ERC20Permit, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }
}
