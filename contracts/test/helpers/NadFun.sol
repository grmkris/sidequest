// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev nad.fun V2's router, the subset the mainnet fork tests use (github.com/Naddotfun/nadfun-v2-intergration,
///      `abi/NadFunRouter.json`). Addresses come from `config/monad-mainnet.json` (`nadfun`).
interface INadFunRouter {
    struct VaultAllocation {
        address vault;
        uint16 bps;
        bytes setupData;
    }

    struct CreateParams {
        string name;
        string symbol;
        string tokenURI;
        address quoteToken;
        uint16 creatorFeeRate;
        VaultAllocation[] vaults;
        bytes32 salt;
        uint8 dexType;
        uint256 buyQuoteAmount;
        uint256 deadline;
    }

    function createWithNative(CreateParams calldata params) external payable returns (address token, uint256 tokenOut);
}
