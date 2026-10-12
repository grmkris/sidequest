// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {AgentSweep} from "../../src/sidequest/AgentSweep.sol";
import {IERC8004Identity} from "../../src/vendor/erc8004/IERC8004.sol";
import {SidequestRecipe} from "../../script/SidequestRecipe.sol";
import {DeployAgentSweep} from "../../script/DeployAgentSweep.s.sol";

/// @dev Stands in for the ERC-8004 Identity Registry: an ERC-721 whose token id is the agent id, plus the agent wallet
///      AgentSweep reads. Unknown agents have no wallet. The live registry is exercised by the fork tests.
contract IdentityStandIn is ERC721 {
    uint256 internal nextId = 1;
    mapping(uint256 agentId => address) public getAgentWallet;

    constructor() ERC721("Agent", "AGENT") {}

    function register(address owner, address wallet) external returns (uint256 agentId) {
        agentId = nextId++;
        _mint(owner, agentId);
        getAgentWallet[agentId] = wallet;
    }
}

contract AgentSweepTest is Test {
    IdentityStandIn internal registry;
    AgentSweep internal sweeper;
    MockPaymentToken internal usdc;
    address internal owner = makeAddr("owner");
    address internal wallet = makeAddr("agent-wallet");
    address internal otherOwner = makeAddr("other-owner");
    address internal otherWallet = makeAddr("other-wallet");
    address internal stranger = makeAddr("stranger");
    uint256 internal agentId;
    uint256 internal otherAgentId;

    function setUp() public {
        registry = new IdentityStandIn();
        sweeper = new AgentSweep(IERC8004Identity(address(registry)));
        usdc = new MockPaymentToken("USD Coin", "USDC");
        agentId = registry.register(owner, wallet);
        otherAgentId = registry.register(otherOwner, otherWallet);
        usdc.mint(wallet, 100e6);
        vm.prank(wallet);
        usdc.approve(address(sweeper), type(uint256).max);
    }

    function test_sweep_paysTheAgentsOwner() public {
        vm.expectEmit(address(sweeper));
        emit AgentSweep.Swept(agentId, address(usdc), owner, 40e6);
        vm.prank(wallet);
        sweeper.sweep(address(usdc), agentId, 40e6);
        assertEq(usdc.balanceOf(owner), 40e6);
        assertEq(usdc.balanceOf(wallet), 60e6);
        assertEq(usdc.balanceOf(address(sweeper)), 0, "nothing stays in the contract");
    }

    function test_sweep_paysWhoeverOwnsTheAgentNow() public {
        address buyer = makeAddr("buyer");
        vm.prank(owner);
        registry.transferFrom(owner, buyer, agentId);
        vm.prank(wallet);
        sweeper.sweep(address(usdc), agentId, 100e6);
        assertEq(usdc.balanceOf(buyer), 100e6);
        assertEq(usdc.balanceOf(owner), 0);
    }

    function test_sweep_refusesEveryoneButTheAgentWallet() public {
        usdc.mint(owner, 1e6);
        vm.prank(owner);
        usdc.approve(address(sweeper), 1e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentSweep.NotAgentWallet.selector, agentId, owner));
        sweeper.sweep(address(usdc), agentId, 1e6);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentSweep.NotAgentWallet.selector, agentId, stranger));
        sweeper.sweep(address(usdc), agentId, 1e6);
    }

    function test_sweep_refusesAnotherAgentsId() public {
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentSweep.NotAgentWallet.selector, otherAgentId, wallet));
        sweeper.sweep(address(usdc), otherAgentId, 1e6);
    }

    function test_sweep_refusesAnUnknownAgent() public {
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentSweep.NotAgentWallet.selector, 99, wallet));
        sweeper.sweep(address(usdc), 99, 1e6);
    }

    /// A zero sweep is refused so that every Swept event records a real transfer.
    function test_sweep_refusesZeroAmount() public {
        vm.prank(wallet);
        vm.expectRevert(AgentSweep.ZeroAmount.selector);
        sweeper.sweep(address(usdc), agentId, 0);
    }

    function test_sweep_needsTheWalletsApproval() public {
        vm.prank(wallet);
        usdc.approve(address(sweeper), 0);
        vm.prank(wallet);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(sweeper), 0, 1e6)
        );
        sweeper.sweep(address(usdc), agentId, 1e6);
    }

    function test_sweep_cannotExceedTheWalletsBalance() public {
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, wallet, 100e6, 101e6));
        sweeper.sweep(address(usdc), agentId, 101e6);
    }

    /// Another account's approval to AgentSweep is useless to an agent: it only ever pulls from the caller.
    function test_sweep_pullsOnlyFromTheCaller() public {
        usdc.mint(otherWallet, 50e6);
        vm.prank(otherWallet);
        usdc.approve(address(sweeper), type(uint256).max);
        vm.prank(wallet);
        sweeper.sweep(address(usdc), agentId, 10e6);
        assertEq(usdc.balanceOf(otherWallet), 50e6);
        assertEq(usdc.balanceOf(wallet), 90e6);
    }

    function test_sweep_refusesATokenThatIsNoContract() public {
        vm.prank(wallet);
        vm.expectRevert();
        sweeper.sweep(makeAddr("not-a-token"), agentId, 1e6);
    }

    function testFuzz_sweep_movesExactlyTheAmount(uint256 amount) public {
        amount = bound(amount, 1, 100e6);
        vm.prank(wallet);
        sweeper.sweep(address(usdc), agentId, amount);
        assertEq(usdc.balanceOf(owner), amount);
        assertEq(usdc.balanceOf(wallet) + amount, 100e6);
    }

    function test_constructor_refusesZeroIdentity() public {
        vm.expectRevert(AgentSweep.ZeroIdentity.selector);
        new AgentSweep(IERC8004Identity(address(0)));
    }
}

contract DeployAgentSweepTest is Test {
    function test_deploysAgainstTheConfiguredRegistry() public {
        vm.chainId(10143);
        string memory json = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        address identity = vm.parseJsonAddress(json, ".erc8004.identity");
        vm.etch(identity, address(new IdentityStandIn()).code);
        AgentSweep sweep = new DeployAgentSweep().run("monad-testnet");
        assertEq(address(sweep.identity()), identity);
    }

    function test_refusesAChainOtherThanTheConfigs() public {
        vm.chainId(10143);
        DeployAgentSweep script = new DeployAgentSweep();
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, 143, 10143));
        script.run("monad-mainnet");
    }

    function test_refusesAMissingRegistry() public {
        vm.chainId(10143);
        string memory json = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        address identity = vm.parseJsonAddress(json, ".erc8004.identity");
        DeployAgentSweep script = new DeployAgentSweep();
        vm.expectRevert(abi.encodeWithSelector(DeployAgentSweep.NoIdentityRegistry.selector, identity));
        script.run("monad-testnet");
    }
}
