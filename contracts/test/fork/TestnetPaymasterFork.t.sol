// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SidequestRecipe} from "../../script/SidequestRecipe.sol";
import {
    IEntryPoint,
    IPaymaster,
    PackedUserOperation,
    SidequestTestnetPaymaster
} from "../../src/testnet/SidequestTestnetPaymaster.sol";

/// @dev The EntryPoint v0.7 calls and events this test drives, beyond the paymaster's own subset.
interface IEntryPointV07 is IEntryPoint {
    struct DepositInfo {
        uint256 deposit;
        bool staked;
        uint112 stake;
        uint32 unstakeDelaySec;
        uint48 withdrawTime;
    }

    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );
    event PostOpRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason);

    error FailedOp(uint256 opIndex, string reason);

    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getNonce(address sender, uint192 key) external view returns (uint256 nonce);
    function getDepositInfo(address account) external view returns (DepositInfo memory info);
}

/// @dev A bare ERC-4337 v0.7 account: any operation the EntryPoint brings is valid, and it runs a batch of calls.
///      It stands in for the EIP7702StatelessDeleGator, whose own signature check is not what this test is about.
contract ForkAccount {
    address internal immutable entryPoint;

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    function validateUserOp(PackedUserOperation calldata, bytes32, uint256 missingAccountFunds)
        external
        returns (uint256)
    {
        require(msg.sender == entryPoint, "not the entry point");
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            require(ok, "prefund");
        }
        return 0;
    }

    function executeBatch(address[] calldata targets, bytes[] calldata data) external {
        require(msg.sender == entryPoint, "not the entry point");
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call(data[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

contract Counter {
    uint256 public count;

    function bump() external {
        ++count;
    }

    function fail() external pure {
        revert("nope");
    }
}

/// @dev The paymaster against the real EntryPoint v0.7 and Circle's testnet USDC on a Monad testnet fork. Runs only
///      with MONAD_TESTNET_RPC_URL set (`forge test --match-path 'test/fork/*'`); skipped otherwise so the default suite
///      stays hermetic. State changes happen on the fork, never on the real chain.
///
///      Inside `handleOps` the Foundry fork reads BASEFEE as 0, so an EIP-1559 fee pair would price every operation at
///      its priority fee alone. The operations here set `maxFeePerGas == maxPriorityFeePerGas`, which the EntryPoint
///      takes as the price as-is, so the charge is checked at a realistic price.
contract TestnetPaymasterForkTest is Test {
    uint256 internal constant RATE = 28_000;
    /// Charged for postOp: about the cold cost of a later charge on Monad, 125k (see test_postOpGas_fitsTheLimit).
    uint256 internal constant POST_OP_GAS = 125_000;
    uint128 internal constant PM_VERIFICATION_GAS = 100_000;
    /// The cold first charge, with an empty treasury, measures about 152k on Monad's gas schedule.
    uint128 internal constant PM_POST_OP_GAS = 200_000;
    /// The FiatToken proxy's implementation slot (keccak256("org.zeppelinos.proxy.implementation")).
    bytes32 internal constant FIAT_TOKEN_IMPLEMENTATION_SLOT =
        0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;

    IEntryPointV07 internal entryPoint;
    IERC20 internal usdc;
    SidequestTestnetPaymaster internal pm;
    ForkAccount internal account;
    Counter internal counter;
    address internal signer;
    uint256 internal signerKey;
    address internal treasury = makeAddr("treasury");
    address payable internal bundler = payable(makeAddr("bundler"));
    bool internal forked;

    struct Outcome {
        bool success;
        uint256 epCost;
        uint256 epGasUsed;
        bool charged;
        uint256 tokenCost;
        uint256 gasCost;
        bool postOpReverted;
    }

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        string memory json = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        entryPoint = IEntryPointV07(vm.parseJsonAddress(json, ".accountAbstraction.entryPoint"));
        usdc = IERC20(vm.parseJsonAddress(json, ".accountAbstraction.gasToken"));
        (signer, signerKey) = makeAddrAndKey("paymaster-signer");
        pm = new SidequestTestnetPaymaster(entryPoint, usdc, signer, treasury, address(this), RATE, POST_OP_GAS);
        vm.deal(address(this), 10 ether);
        pm.deposit{value: 2 ether}();
        pm.addStake{value: 1 ether}(1 days);

        account = new ForkAccount(address(entryPoint));
        counter = new Counter();
        deal(address(usdc), address(account), 5e6);
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function calls(address[] memory targets, bytes[] memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(ForkAccount.executeBatch, (targets, data));
    }

    function approveAndBump() internal view returns (bytes memory) {
        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        (targets[0], data[0]) = (address(usdc), abi.encodeCall(IERC20.approve, (address(pm), 1e6)));
        (targets[1], data[1]) = (address(counter), abi.encodeCall(Counter.bump, ()));
        return calls(targets, data);
    }

    function one(address target, bytes memory data) internal pure returns (bytes memory) {
        address[] memory targets = new address[](1);
        bytes[] memory all = new bytes[](1);
        (targets[0], all[0]) = (target, data);
        return calls(targets, all);
    }

    /// The price every operation here pays: the fork's base fee plus 1 gwei, set as both fee fields.
    function price() internal view returns (uint256) {
        return block.basefee + 1 gwei;
    }

    function op(bytes memory callData, uint256 key) internal view returns (PackedUserOperation memory o) {
        o.sender = address(account);
        o.nonce = entryPoint.getNonce(address(account), 0);
        o.callData = callData;
        o.accountGasLimits = bytes32((uint256(150_000) << 128) | 300_000);
        o.preVerificationGas = 60_000;
        o.gasFees = bytes32((price() << 128) | price());
        o.paymasterAndData = abi.encodePacked(address(pm), PM_VERIFICATION_GAS, PM_POST_OP_GAS);
        uint48 validUntil = uint48(block.timestamp + 600);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(pm.getHash(o, validUntil, 0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        o.paymasterAndData = abi.encodePacked(o.paymasterAndData, validUntil, uint48(0), r, s, v);
    }

    function send(PackedUserOperation memory o) internal returns (Outcome memory out) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = o;
        vm.recordLogs();
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 topic = logs[i].topics[0];
            if (logs[i].emitter == address(entryPoint) && topic == IEntryPointV07.UserOperationEvent.selector) {
                (, out.success, out.epCost, out.epGasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
            if (logs[i].emitter == address(entryPoint) && topic == IEntryPointV07.PostOpRevertReason.selector) {
                out.postOpReverted = true;
            }
            if (logs[i].emitter == address(pm) && topic == SidequestTestnetPaymaster.GasCharged.selector) {
                out.charged = true;
                (out.tokenCost, out.gasCost) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    function test_wiredToTheConfiguredEntryPoint() public onFork {
        assertEq(block.chainid, 10143);
        IEntryPointV07.DepositInfo memory info = entryPoint.getDepositInfo(address(pm));
        assertEq(info.deposit, 2 ether);
        assertTrue(info.staked);
        assertEq(info.stake, 1 ether);
        assertEq(pm.getDeposit(), 2 ether);
        assertEq(usdc.balanceOf(address(account)), 5e6);
    }

    /// The first operation of a fresh account: no allowance at validation, the batch approves, postOp charges.
    function test_batchedApprove_paysGasInUsdc() public onFork {
        uint256 depositBefore = pm.getDeposit();
        Outcome memory out = send(op(approveAndBump(), signerKey));

        assertTrue(out.success);
        assertEq(counter.count(), 1);
        assertTrue(out.charged);
        assertEq(out.epCost, out.epGasUsed * price(), "the EntryPoint priced it at the pinned fee");
        assertEq(out.tokenCost, (out.gasCost + POST_OP_GAS * price()) * RATE / 1e18);
        assertGt(out.tokenCost, 0);
        assertEq(usdc.balanceOf(treasury), out.tokenCost);
        assertEq(usdc.balanceOf(address(account)), 5e6 - out.tokenCost);
        assertEq(pm.getDeposit(), depositBefore - out.epCost, "the paymaster's MON paid the EntryPoint");
        console2.log("gas used (EntryPoint)", out.epGasUsed);
        console2.log("MON paid (wei)", out.epCost);
        console2.log("USDC charged (base units)", out.tokenCost);
    }

    function test_revertedCalls_stillPay() public onFork {
        vm.prank(address(account));
        usdc.approve(address(pm), 1e6);
        Outcome memory out = send(op(one(address(counter), abi.encodeCall(Counter.fail, ())), signerKey));

        assertFalse(out.success);
        assertFalse(out.postOpReverted);
        assertTrue(out.charged);
        assertEq(out.tokenCost, (out.gasCost + POST_OP_GAS * price()) * RATE / 1e18);
        assertGt(out.tokenCost, 0);
        assertEq(usdc.balanceOf(treasury), out.tokenCost);
    }

    /// v0.7: a postOp that cannot collect reverts the operation's own calls, and the paymaster's deposit pays.
    function test_unpaidOperation_isUndone_andCostsOnlyTheDeposit() public onFork {
        uint256 depositBefore = pm.getDeposit();
        Outcome memory out = send(op(one(address(counter), abi.encodeCall(Counter.bump, ())), signerKey));

        assertTrue(out.postOpReverted);
        assertFalse(out.success);
        assertFalse(out.charged);
        assertEq(counter.count(), 0, "the bump was rolled back with the failed postOp");
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(account)), 5e6);
        assertEq(pm.getDeposit(), depositBefore - out.epCost);
        assertGt(out.epCost, 0);
    }

    function test_quoteFromAnotherKey_isRefused() public onFork {
        (, uint256 otherKey) = makeAddrAndKey("not-the-signer");
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op(approveAndBump(), otherKey);
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointV07.FailedOp.selector, 0, "AA34 signature error"));
        entryPoint.handleOps(ops, bundler);
    }

    /// Measures postOp on Monad's gas schedule with every account and slot cold, once into an empty treasury (the most
    /// it can cost) and once into a funded one (every charge after the first), to size `postOpGas` and the limit.
    function test_postOpGas_fitsTheLimit() public onFork {
        vm.prank(address(account));
        usdc.approve(address(pm), 1e6);
        uint256 first = measurePostOp();
        vm.cool(address(pm));
        vm.cool(address(usdc));
        vm.cool(address(uint160(uint256(vm.load(address(usdc), FIAT_TOKEN_IMPLEMENTATION_SLOT)))));
        uint256 steady = measurePostOp();
        console2.log("postOp gas, first charge (empty treasury, cold)", first);
        console2.log("postOp gas, later charges (cold)", steady);
        assertLt(steady, first);
        assertLt(first, PM_POST_OP_GAS);
    }

    function measurePostOp() internal returns (uint256 used) {
        bytes memory context = abi.encode(address(account), RATE);
        vm.prank(address(entryPoint));
        uint256 before = gasleft();
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, context, 1e15, 100 gwei);
        used = before - gasleft();
    }
}
