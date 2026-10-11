// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title NoRenounce
/// @notice Two-step ownership that can move but never be dropped (mainnet gate finding R6). A renounced owner could no
///         longer revoke a bad Holding on the vault, pause through the evaluator or retune fees and bonds, for good.
abstract contract NoRenounce is Ownable2Step {
    error RenounceDisabled();

    /// @notice Always reverts. Ownership moves only by `transferOwnership` and `acceptOwnership`.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
