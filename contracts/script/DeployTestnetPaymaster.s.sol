// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {IEntryPoint, SidequestTestnetPaymaster} from "../src/testnet/SidequestTestnetPaymaster.sol";

/// @notice PAYMASTER_SIGNER=0x… PAYMASTER_TREASURY=0x… PAYMASTER_OWNER=0x… PAYMASTER_EXCHANGE_RATE=28000 \
///           PAYMASTER_POST_OP_GAS=125000 forge script script/DeployTestnetPaymaster.s.sol \
///           --rpc-url $MONAD_TESTNET_RPC_URL --account <keystore> --broadcast
///         or pass the same five values with `--sig "run(address,address,address,uint256,uint256)"`.
///         **Testnet only**: refuses chain 143 and any chain but `config/monad-testnet.json`'s, and the contract refuses
///         143 again. The EntryPoint and the gas token come from that file's `accountAbstraction` block; the signer is
///         the Worker's quote key, the exchange rate is token base units per 1e18 wei (28000 = 0.028 USDC per MON).
///         On Monad's gas schedule `postOp` measures about 125k gas cold and 152k on the first charge into an empty
///         treasury (test/fork/TestnetPaymasterFork.t.sol), so quotes need `pmPostOpGasLimit` of at least ~160k.
///         Afterwards the owner funds and stakes it (`deposit()`, `addStake(uint32)`; bundlers need the stake) and
///         records the address in config.
contract DeployTestnetPaymaster is Script {
    error MainnetRefused();
    error NoEntryPoint(address entryPoint);

    function run() external returns (SidequestTestnetPaymaster) {
        return run(
            vm.envAddress("PAYMASTER_SIGNER"),
            vm.envAddress("PAYMASTER_TREASURY"),
            vm.envAddress("PAYMASTER_OWNER"),
            vm.envUint("PAYMASTER_EXCHANGE_RATE"),
            vm.envUint("PAYMASTER_POST_OP_GAS")
        );
    }

    function run(address signer, address treasury, address owner, uint256 exchangeRate, uint256 postOpGas)
        public
        returns (SidequestTestnetPaymaster paymaster)
    {
        if (block.chainid == 143) revert MainnetRefused();
        string memory json = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        SidequestRecipe.guardChain(vm, json, true);
        IEntryPoint entryPoint = IEntryPoint(vm.parseJsonAddress(json, ".accountAbstraction.entryPoint"));
        IERC20 gasToken = IERC20(vm.parseJsonAddress(json, ".accountAbstraction.gasToken"));
        if (address(entryPoint).code.length == 0) revert NoEntryPoint(address(entryPoint));

        vm.startBroadcast();
        paymaster =
            new SidequestTestnetPaymaster(entryPoint, gasToken, signer, treasury, owner, exchangeRate, postOpGas);
        vm.stopBroadcast();

        console2.log("record as .accountAbstraction.paymaster (then deposit and addStake from the owner):");
        console2.log("  paymaster", address(paymaster));
        console2.log("  entryPoint", address(entryPoint));
        console2.log("  gasToken", address(gasToken));
        console2.log("  signer", signer);
        console2.log("  treasury", treasury);
        console2.log("  owner", owner);
    }
}
