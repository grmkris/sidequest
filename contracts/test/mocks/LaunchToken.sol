// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IFactory} from "../../src/sidequest/interfaces/IFactory.sol";

/// @dev SIDE as the nad.fun launcher creates it: 1e9 tokens with 18 decimals and `permit`, and no `burn`, owner or
///      hooks. The whole supply starts with `holder`.
contract LaunchToken is ERC20, ERC20Permit, IFactory {
    constructor(address holder) ERC20("Sidequest", "SIDE") ERC20Permit("Sidequest") {
        _mint(holder, 1_000_000_000e18);
    }

    function nonces(address owner) public view override(ERC20Permit, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }
}
