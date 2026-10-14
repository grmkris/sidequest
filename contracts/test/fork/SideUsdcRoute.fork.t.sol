// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey, IV4Permit2} from "../../src/sidequest/SeedHelper.sol";

interface IRouterExecute {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IExactQuoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);

    function quoteExactOutputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountIn, uint256 gasEstimate);
}

interface INadRouter {
    struct BuyParams {
        uint256 amountOutMin;
        address token;
        address to;
        uint256 deadline;
    }

    struct SellParams {
        uint256 amountIn;
        uint256 amountOutMin;
        address token;
        address to;
        uint256 deadline;
    }

    function getAmountIn(address token, uint256 amountOut, bool isBuy) external view returns (uint256);
    function getAmountOut(address token, uint256 amountIn, bool isBuy) external view returns (uint256);
    function buyWithNative(BuyParams calldata params) external payable returns (uint256);
    function sellToNative(SellParams calldata params) external returns (uint256);
}

/// @dev ERC-7579 batch execution, as the SDK's executeCalldata encodes it (packages/sdk/src/batch.ts).
interface IBatchExecutor {
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

/// @dev The original v4-periphery single-pool params, which Monad mainnet's UniversalRouter takes.
struct RouteExactOutputSingle {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    bytes hookData;
}

struct RouteExactInputSingle {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/// @dev Buying and selling SIDE with USDC (14 Oct): mainnet's native/USDC pool (config `prices.native`, fee 500,
///      tick spacing 10) turns USDC into exactly the MON a nad.fun buy takes, or a sale's MON back into USDC, through
///      Uniswap's UniversalRouter (config `swap`). This pins the calldata the SDK builds (packages/sdk/src/swap.ts):
///      V4_SWAP with SWAP_EXACT_OUT_SINGLE (0x08) or SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f),
///      native MON as currency0 = address(0). Mainnet fork only, nothing is sent; skipped without MONAD_MAINNET_RPC_URL.
///      Monad's reserve-balance rule is not emulated here: only a live trade proves the net-zero MON case.
contract SideUsdcRouteForkTest is Test {
    bytes32 constant BATCH_DEFAULT_MODE = 0x0100000000000000000000000000000000000000000000000000000000000000;

    address router;
    address quoter;
    address permit2;
    address usdc;
    address side;
    address nad;
    address delegator;
    PoolKey key;

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        router = vm.parseJsonAddress(json, ".swap.universalRouter");
        quoter = vm.parseJsonAddress(json, ".swap.quoter");
        permit2 = vm.parseJsonAddress(json, ".liquidity.uniswapV4.permit2");
        usdc = vm.parseJsonAddress(json, ".prices.native.quote");
        side = vm.parseJsonAddress(json, ".deployment.factory");
        nad = vm.parseJsonAddress(json, ".nadfun.router");
        delegator = vm.parseJsonAddress(json, ".delegation.delegator");
        key = PoolKey(
            address(0),
            usdc,
            uint24(vm.parseJsonUint(json, ".prices.native.fee")),
            int24(int256(vm.parseJsonInt(json, ".prices.native.tickSpacing"))),
            address(0)
        );
        return true;
    }

    /// @dev execute(V4_SWAP) input for USDC in, exactly `monOut` MON out to the caller, at most `usdcMax` USDC spent.
    function _buyMon(uint128 monOut, uint128 usdcMax) internal view returns (bytes memory) {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(RouteExactOutputSingle(key, false, monOut, usdcMax, ""));
        params[1] = abi.encode(usdc, uint256(usdcMax));
        params[2] = abi.encode(address(0), uint256(monOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"080c0f", params);
        return abi.encodeCall(IRouterExecute.execute, (hex"10", inputs, block.timestamp + 600));
    }

    /// @dev execute(V4_SWAP) input for exactly `monIn` MON in (sent as the call's value), at least `usdcMin` USDC out.
    function _sellMon(uint128 monIn, uint128 usdcMin) internal view returns (bytes memory) {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(RouteExactInputSingle(key, true, monIn, usdcMin, ""));
        params[1] = abi.encode(address(0), uint256(monIn));
        params[2] = abi.encode(usdc, uint256(usdcMin));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        return abi.encodeCall(IRouterExecute.execute, (hex"10", inputs, block.timestamp + 600));
    }

    function _usdcFor(uint128 monOut) internal returns (uint256 usdcIn) {
        (usdcIn,) =
            IExactQuoter(quoter).quoteExactOutputSingle(IExactQuoter.QuoteExactSingleParams(key, false, monOut, ""));
    }

    function _usdcOut(uint128 monIn) internal returns (uint256 usdcOut) {
        (usdcOut,) =
            IExactQuoter(quoter).quoteExactInputSingle(IExactQuoter.QuoteExactSingleParams(key, true, monIn, ""));
    }

    function _approveUsdc(address owner, uint256 amount) internal {
        vm.startPrank(owner);
        IERC20(usdc).approve(permit2, amount);
        IV4Permit2(permit2).approve(usdc, router, uint160(amount), uint48(block.timestamp + 1800));
        vm.stopPrank();
    }

    /// @dev Exact output: the wallet receives exactly the MON asked for, pays the quote, and a bound under it refuses.
    function test_fork_usdcBuysExactMon() public {
        if (!_fork()) return vm.skip(true);
        address buyer = makeAddr("usdc-buyer");
        deal(usdc, buyer, 100e6);
        uint128 monOut = 100 ether;
        uint256 usdcIn = _usdcFor(monOut);
        assertGt(usdcIn, 0);
        _approveUsdc(buyer, usdcIn);
        vm.prank(buyer);
        (bool tight,) = router.call(_buyMon(monOut, uint128(usdcIn - 1)));
        assertFalse(tight, "a maximum under the quote is refused");
        vm.prank(buyer);
        (bool ok,) = router.call(_buyMon(monOut, uint128(usdcIn)));
        assertTrue(ok);
        assertEq(buyer.balance, monOut);
        assertEq(IERC20(usdc).balanceOf(buyer), 100e6 - usdcIn);
    }

    /// @dev Exact input with native MON: the call's value is what the router settles; a minimum over the quote refuses.
    function test_fork_monSellsForUsdc() public {
        if (!_fork()) return vm.skip(true);
        address seller = makeAddr("mon-seller");
        vm.deal(seller, 100 ether);
        uint128 monIn = 50 ether;
        uint256 quoted = _usdcOut(monIn);
        assertGt(quoted, 0);
        vm.prank(seller);
        (bool greedy,) = router.call{value: monIn}(_sellMon(monIn, uint128(quoted + 1)));
        assertFalse(greedy, "a minimum over the quote is refused");
        vm.prank(seller);
        (bool ok,) = router.call{value: monIn}(_sellMon(monIn, uint128(quoted)));
        assertTrue(ok);
        assertEq(seller.balance, 50 ether);
        assertEq(IERC20(usdc).balanceOf(seller), quoted);
    }

    /// @dev The whole route from a wallet that holds only USDC: buy SIDE (MON ends where it started, at zero), then
    ///      sell it back into USDC (the MON above the sale's floor stays in the wallet).
    function test_fork_sideBoughtAndSoldWithUsdc() public {
        if (!_fork()) return vm.skip(true);
        address wallet = makeAddr("usdc-only");
        deal(usdc, wallet, 50e6);
        uint256 sideWanted = 100_000 ether;
        uint128 mon = uint128(INadRouter(nad).getAmountIn(side, sideWanted, true));
        uint256 usdcMax = _usdcFor(mon) * 10_300 / 10_000;
        _approveUsdc(wallet, usdcMax);
        vm.startPrank(wallet);
        (bool swapped,) = router.call(_buyMon(mon, uint128(usdcMax)));
        assertTrue(swapped);
        INadRouter(nad).buyWithNative{value: mon}(
            INadRouter.BuyParams(sideWanted * 9_700 / 10_000, side, wallet, block.timestamp + 600)
        );
        vm.stopPrank();
        assertEq(wallet.balance, 0, "the buy spent exactly the MON the swap delivered");
        uint256 held = IERC20(side).balanceOf(wallet);
        assertGe(held, sideWanted * 9_700 / 10_000);

        uint256 monQuoted = INadRouter(nad).getAmountOut(side, held, false);
        uint128 monMin = uint128(monQuoted * 9_700 / 10_000);
        uint256 usdcMin = _usdcOut(monMin) * 9_700 / 10_000;
        uint256 usdcBefore = IERC20(usdc).balanceOf(wallet);
        vm.startPrank(wallet);
        IERC20(side).approve(nad, held);
        INadRouter(nad).sellToNative(INadRouter.SellParams(held, monMin, side, wallet, block.timestamp + 600));
        (bool sold,) = router.call{value: monMin}(_sellMon(monMin, uint128(usdcMin)));
        assertTrue(sold);
        vm.stopPrank();
        assertGe(IERC20(usdc).balanceOf(wallet) - usdcBefore, usdcMin);
        assertEq(IERC20(side).balanceOf(wallet), 0);
        assertEq(wallet.balance, monQuoted - monMin, "the MON above the sale's floor stays in the wallet");
    }

    /// @dev The buy as Explore sends it: one ERC-7579 batch from a wallet delegated (EIP-7702) to the configured
    ///      DeleGator. It accepts the swapped MON and forwards it as the next call's value; a floor too high reverts all.
    function test_fork_delegatedWalletBuysInOneBatch() public {
        if (!_fork()) return vm.skip(true);
        (address wallet, uint256 pk) = makeAddrAndKey("delegated-usdc-only");
        vm.signAndAttachDelegation(delegator, pk);
        deal(usdc, wallet, 50e6);
        uint256 sideWanted = 100_000 ether;
        uint128 mon = uint128(INadRouter(nad).getAmountIn(side, sideWanted, true));
        uint256 usdcMax = _usdcFor(mon) * 10_300 / 10_000;

        IBatchExecutor.Execution[] memory calls = new IBatchExecutor.Execution[](4);
        calls[0] = IBatchExecutor.Execution(usdc, 0, abi.encodeCall(IERC20.approve, (permit2, usdcMax)));
        calls[1] = IBatchExecutor.Execution(
            permit2,
            0,
            abi.encodeCall(IV4Permit2.approve, (usdc, router, uint160(usdcMax), uint48(block.timestamp + 1800)))
        );
        calls[2] = IBatchExecutor.Execution(router, 0, _buyMon(mon, uint128(usdcMax)));
        calls[3] = IBatchExecutor.Execution(
            nad,
            mon,
            abi.encodeCall(
                INadRouter.buyWithNative,
                (INadRouter.BuyParams(sideWanted * 9_700 / 10_000, side, wallet, block.timestamp + 600))
            )
        );

        // A floor above what the curve gives reverts the whole batch: no USDC leaves the wallet.
        IBatchExecutor.Execution[] memory greedy = new IBatchExecutor.Execution[](4);
        for (uint256 i; i < 4; i++) {
            greedy[i] = calls[i];
        }
        greedy[3] = IBatchExecutor.Execution(
            nad,
            mon,
            abi.encodeCall(
                INadRouter.buyWithNative, (INadRouter.BuyParams(sideWanted * 2, side, wallet, block.timestamp + 600))
            )
        );
        vm.prank(wallet);
        (bool reverted,) = wallet.call(abi.encodeCall(IBatchExecutor.execute, (BATCH_DEFAULT_MODE, abi.encode(greedy))));
        assertFalse(reverted, "an unmet floor reverts every call");
        assertEq(IERC20(usdc).balanceOf(wallet), 50e6);

        vm.prank(wallet);
        IBatchExecutor(wallet).execute(BATCH_DEFAULT_MODE, abi.encode(calls));
        assertEq(wallet.balance, 0, "MON ends where it started");
        assertGe(IERC20(side).balanceOf(wallet), sideWanted * 9_700 / 10_000);
        assertLe(50e6 - IERC20(usdc).balanceOf(wallet), usdcMax);
    }
}
