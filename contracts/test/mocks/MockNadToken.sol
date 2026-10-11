// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev A stateless stand-in for the nad.fun token implementation: an EIP-1167 clone of it answers like a launch token
///      (Sidequest / SIDE, 18 decimals, 1e9 supply, on `curve`) without any storage, so the recipe's mainnet pin can be
///      tested against a real clone. Not an ERC-20: it moves nothing.
contract MockNadToken {
    address public immutable curve;

    constructor(address curve_) {
        curve = curve_;
    }

    function name() external pure returns (string memory) {
        return "Sidequest";
    }

    function symbol() external pure returns (string memory) {
        return "SIDE";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 1_000_000_000e18;
    }

    function bondingCurve() external view returns (address) {
        return curve;
    }
}
