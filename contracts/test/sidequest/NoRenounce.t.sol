// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {NoRenounce} from "../../src/sidequest/NoRenounce.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Finding R6: no owned v1 contract can be left without an owner, and ownership still moves in two steps.
contract NoRenounceTest is BaseV1 {
    function owned() internal view returns (address[4] memory) {
        return [address(vault), address(fees), address(holding), address(evaluator)];
    }

    function test_noOwnedContractCanRenounce() public {
        address[4] memory contracts = owned();
        for (uint256 i; i < contracts.length; ++i) {
            address owner = Ownable(contracts[i]).owner();
            vm.prank(owner);
            vm.expectRevert(NoRenounce.RenounceDisabled.selector);
            Ownable(contracts[i]).renounceOwnership();
            assertEq(Ownable(contracts[i]).owner(), owner, "owner unchanged");
        }
    }

    function test_ownershipStillMovesInTwoSteps() public {
        address safe = makeAddr("safe");
        address[4] memory contracts = owned();
        for (uint256 i; i < contracts.length; ++i) {
            vm.prank(Ownable(contracts[i]).owner());
            Ownable2Step(contracts[i]).transferOwnership(safe);
            vm.prank(safe);
            Ownable2Step(contracts[i]).acceptOwnership();
            assertEq(Ownable(contracts[i]).owner(), safe);
        }
    }
}
