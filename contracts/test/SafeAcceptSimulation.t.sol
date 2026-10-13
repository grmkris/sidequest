// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeAccept} from "../script/SafeAccept.s.sol";
import {SidequestRecipe} from "../script/SidequestRecipe.sol";

contract AcceptTarget is Ownable2Step {
    constructor(address deployer) Ownable(deployer) {}
}

/// @dev Only the acceptance interface is doubled here; production Safe integration is the coordinator's R7 probe.
contract AcceptSimulationSafe {
    address internal immutable signer;
    uint256 public nonce;

    constructor(address signer_) { signer = signer_; }
    function isOwner(address account) external view returns (bool) { return account == signer; }
    function getThreshold() external pure returns (uint256) { return 1; }
    function execTransaction(
        address to, uint256, bytes calldata data, uint8, uint256, uint256, uint256, address, address payable, bytes calldata
    ) external returns (bool) {
        require(msg.sender == signer, "unexpected Safe sender");
        ++nonce;
        (bool success,) = to.call(data);
        require(success, "accept failed");
        return true;
    }
}

contract SafeAcceptSimulationTest is Test {
    SafeAccept internal script;
    AcceptSimulationSafe internal safe;
    AcceptTarget[4] internal targets;
    address internal owner;
    string internal path;
    string internal input;

    function setUp() public {
        vm.chainId(143);
        vm.setEnv("MAINNET_GO", "");
        owner = address(this);
        safe = new AcceptSimulationSafe(owner);
        for (uint256 i; i < 4; ++i) {
            targets[i] = new AcceptTarget(address(this));
            targets[i].transferOwnership(address(safe));
        }
        input = string.concat(
            '{"chainId":143,"deployment":{"sidequest":{"safe":"', vm.toString(address(safe)),
            '","vault":"', vm.toString(address(targets[0])), '","feeSchedule":"', vm.toString(address(targets[1])),
            '"},"main":{"holding":"', vm.toString(address(targets[2])), '","evaluator":"',
            vm.toString(address(targets[3])), '"}}}'
        );
        script = new SafeAccept();
    }

    function _prepare(string memory name) internal {
        string memory network = string.concat(".test-accept-", name);
        vm.setEnv("NETWORK", network);
        vm.setEnv("MAINNET_GO", "");
        path = SidequestRecipe.path(vm, network);
        vm.writeFile(path, input);
    }

    function _cleanup() internal {
        vm.removeFile(path);
    }

    function test_mainnetPlanSimulatesPendingAcceptancesWithoutGo() public {
        _prepare("simulation");
        (bool success, bytes memory reason) = address(script).call(abi.encodeWithSignature("simulate()"));
        assertTrue(success, string(reason));
        for (uint256 i; i < 4; ++i) assertEq(targets[i].owner(), address(safe));
        assertEq(safe.nonce(), 4);
        (success,) = address(script).call(abi.encodeWithSignature("simulate()"));
        assertTrue(success, "repeated simulation failed");
        assertEq(safe.nonce(), 4, "already accepted contracts were sent again");
        _cleanup();
    }

    function test_mainnetSendStillNeedsGo() public {
        _prepare("send");
        vm.expectRevert(SidequestRecipe.MainnetNotGo.selector);
        script.run();
        assertEq(safe.nonce(), 0);
        _cleanup();
    }

    function test_planRefusesWrongChainWithoutGo() public {
        _prepare("chain");
        vm.chainId(10143);
        (bool success, bytes memory reason) = address(script).call(abi.encodeWithSignature("simulate()"));
        assertFalse(success);
        assertEq(reason, abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, uint256(143), uint256(10143)));
        assertEq(safe.nonce(), 0);
        _cleanup();
    }
}
