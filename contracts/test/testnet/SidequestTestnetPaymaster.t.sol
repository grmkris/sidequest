// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {
    IEntryPoint,
    IPaymaster,
    PackedUserOperation,
    SidequestTestnetPaymaster
} from "../../src/testnet/SidequestTestnetPaymaster.sol";
import {SidequestRecipe} from "../../script/SidequestRecipe.sol";
import {DeployTestnetPaymaster} from "../../script/DeployTestnetPaymaster.s.sol";

/// @dev The EntryPoint's deposit and stake book, enough to see the paymaster forward its owner's calls. The real
///      EntryPoint's validation and postOp flow is exercised by test/fork/TestnetPaymasterFork.t.sol.
contract EntryPointStandIn is IEntryPoint {
    mapping(address account => uint256) public balanceOf;
    mapping(address account => uint256) public stakeOf;
    mapping(address account => uint32) public unstakeDelayOf;
    mapping(address account => bool) public unlocked;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        stakeOf[msg.sender] += msg.value;
        unstakeDelayOf[msg.sender] = unstakeDelaySec;
    }

    function unlockStake() external {
        unlocked[msg.sender] = true;
    }

    function withdrawStake(address payable withdrawAddress) external {
        require(unlocked[msg.sender], "stake locked");
        uint256 amount = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok,) = withdrawAddress.call{value: amount}("");
        require(ok, "send failed");
    }

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external {
        balanceOf[msg.sender] -= withdrawAmount;
        (bool ok,) = withdrawAddress.call{value: withdrawAmount}("");
        require(ok, "send failed");
    }
}

contract SidequestTestnetPaymasterTest is Test {
    /// 0.028 USDC per MON: 6-decimal base units per 1e18 wei.
    uint256 internal constant RATE = 28_000;
    uint256 internal constant POST_OP_GAS = 60_000;
    uint256 internal constant MAX_COST = 1e16;

    EntryPointStandIn internal ep;
    MockPaymentToken internal usdc;
    SidequestTestnetPaymaster internal pm;
    address internal signer;
    uint256 internal signerKey;
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal account = makeAddr("account");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_790_000_000);
        (signer, signerKey) = makeAddrAndKey("signer");
        ep = new EntryPointStandIn();
        usdc = new MockPaymentToken("USD Coin", "USDC");
        pm = deploy();
        usdc.mint(account, 10e6);
        vm.prank(account);
        usdc.approve(address(pm), 1e6);
    }

    function deploy() internal returns (SidequestTestnetPaymaster) {
        return new SidequestTestnetPaymaster(ep, IERC20(address(usdc)), signer, treasury, owner, RATE, POST_OP_GAS);
    }

    /// An unsigned operation: `paymasterAndData` holds only the 52 static bytes `getHash` reads.
    function unsigned(SidequestTestnetPaymaster paymaster) internal view returns (PackedUserOperation memory op) {
        op.sender = account;
        op.nonce = 7;
        op.callData = hex"deadbeef";
        op.accountGasLimits = bytes32((uint256(200_000) << 128) | 300_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(2 gwei) << 128) | 100 gwei);
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(150_000), uint128(80_000));
    }

    function signed(PackedUserOperation memory op, uint256 key, uint48 validUntil, uint48 validAfter)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(pm.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, validUntil, validAfter, r, s, v);
        return op;
    }

    function window() internal view returns (uint48 validUntil, uint48 validAfter) {
        return (uint48(block.timestamp + 300), uint48(block.timestamp - 10));
    }

    function validate(PackedUserOperation memory op) internal returns (bytes memory context, uint256 validationData) {
        vm.prank(address(ep));
        return pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
    }

    function packed(bool sigFailed, uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (sigFailed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    // ------------------------------------------------------------------ validation

    function test_validate_signedQuote_returnsWindowAndRateContext() public {
        (uint48 until, uint48 after_) = window();
        (bytes memory context, uint256 validationData) = validate(signed(unsigned(pm), signerKey, until, after_));
        assertEq(validationData, packed(false, until, after_));
        assertEq(uint160(validationData), 0, "no failure bit, no aggregator");
        (address sender, uint256 rate) = abi.decode(context, (address, uint256));
        assertEq(sender, account);
        assertEq(rate, RATE);
    }

    function test_validate_wrongSigner_setsFailureBit_keepsWindowAndContext() public {
        (, uint256 otherKey) = makeAddrAndKey("not-the-signer");
        (uint48 until, uint48 after_) = window();
        (bytes memory context, uint256 validationData) = validate(signed(unsigned(pm), otherKey, until, after_));
        assertEq(validationData, packed(true, until, after_));
        assertEq(context, abi.encode(account, RATE), "a stub signature still walks the postOp path");
    }

    function test_validate_garbageSignature_failsWithoutReverting() public {
        (uint48 until, uint48 after_) = window();
        PackedUserOperation memory op = unsigned(pm);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, until, after_, new bytes(65));
        (, uint256 validationData) = validate(op);
        assertEq(validationData, packed(true, until, after_));

        op = unsigned(pm);
        bytes memory ones = new bytes(65);
        for (uint256 i; i < 65; ++i) {
            ones[i] = 0xff;
        }
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, until, after_, ones);
        (, validationData) = validate(op);
        assertEq(validationData, packed(true, until, after_));
    }

    function test_validate_expiredWindow_isPassedToTheEntryPoint() public {
        uint48 until = uint48(block.timestamp - 1);
        uint48 after_ = uint48(block.timestamp - 600);
        (, uint256 validationData) = validate(signed(unsigned(pm), signerKey, until, after_));
        assertEq(validationData, packed(false, until, after_), "the EntryPoint, not the paymaster, refuses it");
        assertEq(uint48(validationData >> 160), until);
        assertEq(uint48(validationData >> 208), after_);

        (, validationData) = validate(signed(unsigned(pm), signerKey, 0, 0));
        assertEq(validationData, 0, "validUntil 0 means no expiry");
    }

    function testFuzz_validate_packsAnyWindow(uint48 until, uint48 after_) public {
        (, uint256 validationData) = validate(signed(unsigned(pm), signerKey, until, after_));
        assertEq(validationData, packed(false, until, after_));
    }

    function test_validate_quoteBindsTheOperation() public {
        (uint48 until, uint48 after_) = window();
        PackedUserOperation memory good = signed(unsigned(pm), signerKey, until, after_);
        PackedUserOperation memory op;

        op = signed(unsigned(pm), signerKey, until, after_);
        op.callData = hex"deadbeee";
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.nonce++;
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.sender = alice;
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.initCode = hex"01";
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.accountGasLimits = bytes32(uint256(op.accountGasLimits) + 1);
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.preVerificationGas++;
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.gasFees = bytes32(uint256(op.gasFees) + 1);
        assertFailed(op);

        // The paymaster gas limits and the window sit inside paymasterAndData.
        op = signed(unsigned(pm), signerKey, until, after_);
        op.paymasterAndData[35] = bytes1(uint8(op.paymasterAndData[35]) ^ 1);
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.paymasterAndData[51] = bytes1(uint8(op.paymasterAndData[51]) ^ 1);
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.paymasterAndData[57] = bytes1(uint8(op.paymasterAndData[57]) ^ 1);
        assertFailed(op);
        op = signed(unsigned(pm), signerKey, until, after_);
        op.paymasterAndData[63] = bytes1(uint8(op.paymasterAndData[63]) ^ 1);
        assertFailed(op);

        // The account's own signature is not part of the quote.
        good.signature = hex"1234";
        (, uint256 validationData) = validate(good);
        assertEq(validationData, packed(false, until, after_));

        // Another chain does not accept the quote.
        vm.chainId(10144);
        assertFailed(good);
    }

    function test_validate_quoteBindsThePaymaster() public {
        SidequestTestnetPaymaster other = deploy();
        (uint48 until, uint48 after_) = window();
        PackedUserOperation memory op = signed(unsigned(other), signerKey, until, after_);
        vm.prank(address(ep));
        (, uint256 validationData) = other.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        assertEq(validationData, packed(true, until, after_), "signed for pm, presented to other");
    }

    function assertFailed(PackedUserOperation memory op) internal {
        (, uint256 validationData) = validate(op);
        assertEq(validationData & 1, 1, "tampered operation must fail the signature");
    }

    function test_validate_refusesMalformedPaymasterData() public {
        PackedUserOperation memory op = unsigned(pm);
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(SidequestTestnetPaymaster.InvalidPaymasterData.selector, 52));
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);

        (uint48 until, uint48 after_) = window();
        op = signed(unsigned(pm), signerKey, until, after_);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, hex"00");
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(SidequestTestnetPaymaster.InvalidPaymasterData.selector, 130));
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);

        op.paymasterAndData = new bytes(40);
        vm.expectRevert(abi.encodeWithSelector(SidequestTestnetPaymaster.InvalidPaymasterData.selector, 40));
        pm.getHash(op, until, after_);
    }

    /// The approve and the gas float may come in the operation's own calls, so validation never reads funds.
    function test_validate_doesNotRequireFundsYet() public {
        vm.prank(account);
        usdc.approve(address(pm), 0);
        vm.prank(account);
        usdc.transfer(alice, 10e6);
        (uint48 until, uint48 after_) = window();
        (, uint256 validationData) = validate(signed(unsigned(pm), signerKey, until, after_));
        assertEq(validationData, packed(false, until, after_));
    }

    function test_getHash_coversChainAndPaymaster_notTheSignatures() public {
        PackedUserOperation memory op = unsigned(pm);
        bytes32 h = pm.getHash(op, 1, 2);
        op.signature = hex"abcd";
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, uint48(1), uint48(2), new bytes(65));
        assertEq(pm.getHash(op, 1, 2), h, "signatures and trailing data are outside the quote");
        assertTrue(pm.getHash(op, 1, 3) != h, "the window is inside");
        vm.chainId(1);
        assertTrue(pm.getHash(op, 1, 2) != h, "the chain is inside");
    }

    // ------------------------------------------------------------------ postOp

    function test_postOp_chargesTheTreasury_whenTheOpSucceededOrReverted() public {
        // (0.001 MON + 60k gas * 100 gwei) * 28_000 / 1e18 = 196 base units
        uint256 gasCost = 1e15;
        uint256 fee = 100 gwei;
        uint256 expected = (gasCost + POST_OP_GAS * fee) * RATE / 1e18;
        assertEq(expected, 196);

        vm.expectEmit(address(pm));
        emit SidequestTestnetPaymaster.GasCharged(account, expected, gasCost);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(account, RATE), gasCost, fee);
        assertEq(usdc.balanceOf(treasury), expected);
        assertEq(usdc.balanceOf(account), 10e6 - expected);

        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opReverted, abi.encode(account, RATE), gasCost, fee);
        assertEq(usdc.balanceOf(treasury), 2 * expected, "a reverted operation still pays");
    }

    function test_postOp_chargesAtTheQuotedRate() public {
        (uint48 until, uint48 after_) = window();
        (bytes memory context,) = validate(signed(unsigned(pm), signerKey, until, after_));
        vm.prank(owner);
        pm.setExchangeRate(RATE * 2);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, context, 1e15, 100 gwei);
        assertEq(usdc.balanceOf(treasury), 196, "the rate quoted at validation, not the new one");

        (context,) = validate(signed(unsigned(pm), signerKey, until, after_));
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, context, 1e15, 100 gwei);
        assertEq(usdc.balanceOf(treasury), 196 + 392);
    }

    /// A reverting postOp is what makes the v0.7 EntryPoint undo the operation's own calls.
    function test_postOp_revertsWhenTheSenderCannotPay() public {
        vm.prank(account);
        usdc.approve(address(pm), 0);
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pm), 0, 196));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(account, RATE), 1e15, 100 gwei);
    }

    function test_postOp_zeroCost_movesNothing() public {
        vm.prank(account);
        usdc.approve(address(pm), 0);
        vm.expectEmit(address(pm));
        emit SidequestTestnetPaymaster.GasCharged(account, 0, 1);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(account, RATE), 1, 0);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    /// Realistic ranges (gas <= 30M, fee <= 1e13 wei, rate <= 1e12) never overflow, and a charge for usage within the
    /// operation's limits never exceeds the token value of its maximum cost, which is what the signer quotes.
    function testFuzz_postOp_costMath(
        uint256 gasUsed,
        uint256 slack,
        uint256 fee,
        uint256 maxFeeSlack,
        uint256 rate,
        uint256 postOpGas
    ) public {
        gasUsed = bound(gasUsed, 0, 30_000_000);
        slack = bound(slack, 0, 30_000_000);
        fee = bound(fee, 0, 1e13);
        maxFeeSlack = bound(maxFeeSlack, 0, 1e13);
        rate = bound(rate, 1, 1e12);
        postOpGas = bound(postOpGas, 0, 1_000_000);
        vm.prank(owner);
        pm.setPostOpGas(postOpGas);

        uint256 expected = (gasUsed * fee + postOpGas * fee) * rate / 1e18;
        usdc.mint(account, expected);
        vm.prank(account);
        usdc.approve(address(pm), type(uint256).max);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(account, rate), gasUsed * fee, fee);
        assertEq(usdc.balanceOf(treasury), expected);

        uint256 maxCost = (gasUsed + postOpGas + slack) * (fee + maxFeeSlack);
        assertLe(expected, maxCost * rate / 1e18);
    }

    function test_onlyTheEntryPoint_validatesAndCharges() public {
        PackedUserOperation memory op = signed(unsigned(pm), signerKey, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SidequestTestnetPaymaster.NotEntryPoint.selector, alice));
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SidequestTestnetPaymaster.NotEntryPoint.selector, alice));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(account, RATE), 1e15, 100 gwei);
    }

    // ------------------------------------------------------------------ construction and owner

    function test_constructor_refusesMainnet() public {
        vm.chainId(143);
        vm.expectRevert(SidequestTestnetPaymaster.MainnetRefused.selector);
        deploy();
    }

    function test_constructor_refusesZeroInputs() public {
        IERC20 t = IERC20(address(usdc));
        vm.expectRevert(SidequestTestnetPaymaster.ZeroAddress.selector);
        new SidequestTestnetPaymaster(IEntryPoint(address(0)), t, signer, treasury, owner, RATE, POST_OP_GAS);
        vm.expectRevert(SidequestTestnetPaymaster.ZeroAddress.selector);
        new SidequestTestnetPaymaster(ep, IERC20(address(0)), signer, treasury, owner, RATE, POST_OP_GAS);
        vm.expectRevert(SidequestTestnetPaymaster.ZeroAddress.selector);
        new SidequestTestnetPaymaster(ep, t, address(0), treasury, owner, RATE, POST_OP_GAS);
        vm.expectRevert(SidequestTestnetPaymaster.ZeroAddress.selector);
        new SidequestTestnetPaymaster(ep, t, signer, address(0), owner, RATE, POST_OP_GAS);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SidequestTestnetPaymaster(ep, t, signer, treasury, address(0), RATE, POST_OP_GAS);
        vm.expectRevert(SidequestTestnetPaymaster.ZeroExchangeRate.selector);
        new SidequestTestnetPaymaster(ep, t, signer, treasury, owner, 0, POST_OP_GAS);
    }

    function test_constructor_recordsItsInputs() public view {
        assertEq(address(pm.entryPoint()), address(ep));
        assertEq(address(pm.token()), address(usdc));
        assertEq(pm.signer(), signer);
        assertEq(pm.treasury(), treasury);
        assertEq(pm.owner(), owner);
        assertEq(pm.exchangeRate(), RATE);
        assertEq(pm.postOpGas(), POST_OP_GAS);
        assertEq(pm.PAYMASTER_AND_DATA_LENGTH(), 129);
    }

    function test_deposit_isOpenToAnyone() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        pm.deposit{value: 1 ether}();
        assertEq(ep.balanceOf(address(pm)), 1 ether);
        assertEq(pm.getDeposit(), 1 ether);
    }

    function test_owner_stakesAndWithdraws() public {
        address payable to = payable(makeAddr("to"));
        vm.deal(owner, 3 ether);
        vm.startPrank(owner);
        pm.deposit{value: 1 ether}();
        pm.addStake{value: 2 ether}(1 days);
        assertEq(ep.stakeOf(address(pm)), 2 ether);
        assertEq(ep.unstakeDelayOf(address(pm)), 1 days);
        pm.withdrawTo(to, 0.25 ether);
        pm.unlockStake();
        pm.withdrawStake(to);
        vm.stopPrank();
        assertEq(to.balance, 2.25 ether);
        assertEq(pm.getDeposit(), 0.75 ether);
        assertEq(ep.stakeOf(address(pm)), 0);
    }

    function test_owner_setsPricing() public {
        vm.startPrank(owner);
        vm.expectEmit(address(pm));
        emit SidequestTestnetPaymaster.ExchangeRateSet(30_000);
        pm.setExchangeRate(30_000);
        vm.expectEmit(address(pm));
        emit SidequestTestnetPaymaster.PostOpGasSet(70_000);
        pm.setPostOpGas(70_000);
        vm.expectRevert(SidequestTestnetPaymaster.ZeroExchangeRate.selector);
        pm.setExchangeRate(0);
        vm.stopPrank();
        assertEq(pm.exchangeRate(), 30_000);
        assertEq(pm.postOpGas(), 70_000);
    }

    function test_ownerFunctions_refuseEveryoneElse() public {
        vm.deal(alice, 1 ether);
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(unauthorized);
        pm.addStake{value: 1 ether}(1 days);
        vm.expectRevert(unauthorized);
        pm.unlockStake();
        vm.expectRevert(unauthorized);
        pm.withdrawStake(payable(alice));
        vm.expectRevert(unauthorized);
        pm.withdrawTo(payable(alice), 0);
        vm.expectRevert(unauthorized);
        pm.setExchangeRate(1);
        vm.expectRevert(unauthorized);
        pm.setPostOpGas(1);
        vm.stopPrank();
    }
}

contract DeployTestnetPaymasterTest is Test {
    address internal signer = makeAddr("signer");
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");

    function configured(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(SidequestRecipe.path(vm, "monad-testnet")), key);
    }

    function test_deploysAgainstTheConfiguredEntryPointAndToken() public {
        vm.chainId(10143);
        address entryPoint = configured(".accountAbstraction.entryPoint");
        vm.etch(entryPoint, address(new EntryPointStandIn()).code);
        SidequestTestnetPaymaster pm = new DeployTestnetPaymaster().run(signer, treasury, owner, 28_000, 60_000);
        assertEq(address(pm.entryPoint()), entryPoint);
        assertEq(address(pm.token()), configured(".accountAbstraction.gasToken"));
        assertEq(pm.signer(), signer);
        assertEq(pm.treasury(), treasury);
        assertEq(pm.owner(), owner);
        assertEq(pm.exchangeRate(), 28_000);
        assertEq(pm.postOpGas(), 60_000);
    }

    function test_refusesMainnetAndOtherChains() public {
        DeployTestnetPaymaster script = new DeployTestnetPaymaster();
        vm.chainId(143);
        vm.expectRevert(DeployTestnetPaymaster.MainnetRefused.selector);
        script.run(signer, treasury, owner, 28_000, 60_000);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, 10143, 1));
        script.run(signer, treasury, owner, 28_000, 60_000);
    }

    function test_refusesAChainWithoutTheEntryPoint() public {
        vm.chainId(10143);
        DeployTestnetPaymaster script = new DeployTestnetPaymaster();
        address entryPoint = configured(".accountAbstraction.entryPoint");
        vm.expectRevert(abi.encodeWithSelector(DeployTestnetPaymaster.NoEntryPoint.selector, entryPoint));
        script.run(signer, treasury, owner, 28_000, 60_000);
    }
}
