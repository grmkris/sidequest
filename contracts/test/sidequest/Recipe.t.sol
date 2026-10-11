// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {IFactory} from "../../src/sidequest/interfaces/IFactory.sol";
import {SidequestRecipe} from "../../script/SidequestRecipe.sol";
import {SidequestOutput} from "../../script/SidequestOutput.sol";
import {SidequestVerify} from "../../script/SidequestVerify.sol";
import {SidequestHolding} from "../../src/sidequest/SidequestHolding.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {MockReputation} from "../mocks/MockReputation.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {UnpromotedTestnet} from "../helpers/UnpromotedTestnet.sol";

/// @dev Calls the recipe's steps one at a time under the deployer, so the test can act as a third party between them.
contract RecipeDriver is Test {
    SidequestRecipe.Config internal c;
    SidequestRecipe.Deployed internal d;

    function configure(SidequestRecipe.Config memory c_) external {
        c = c_;
        SidequestRecipe.check(c);
    }

    function step(uint256 i) external {
        SidequestRecipe.Config memory cc = c;
        SidequestRecipe.Deployed memory dd = d;
        vm.startPrank(cc.admin);
        if (i == 0) SidequestRecipe.stepCore(cc, dd);
        if (i == 1) SidequestRecipe.stepFeeSchedule(cc, dd);
        if (i == 2) SidequestRecipe.stepVault(cc, dd);
        if (i == 3) SidequestRecipe.stepHolding(cc, dd);
        if (i == 4) SidequestRecipe.stepEvaluator(cc, dd);
        if (i == 5) SidequestRecipe.stepWire(cc, dd);
        if (i == 6) SidequestRecipe.stepBootstrap(dd);
        if (i == 7) SidequestRecipe.stepHandover(cc, dd);
        vm.stopPrank();
        d = dd;
    }

    function deployed() external view returns (SidequestRecipe.Deployed memory) {
        return d;
    }
}

contract RecipeTest is Test {
    address admin = makeAddr("deployer");
    address safe = makeAddr("safe");
    address ecosystem = makeAddr("ecosystem");
    address attester = makeAddr("attester");
    address stranger = makeAddr("stranger");
    address arbitrator;
    uint256 arbitratorPk;
    RecipeDriver driver;
    SidequestRecipe.Config c;
    /// @dev SIDE as the launcher creates it, before the recipe runs: the deployer holds it, `ecosystem` some.
    LaunchToken side;

    function setUp() public {
        c.maxMinimumCreatorBond = 100_000e18;
        c.unfilledForfeitBps = 2500;
        c.minimumCreatorBond = 10_000e18;
        vm.warp(1_800_000_000);
        side = new LaunchToken(admin);
        vm.prank(admin);
        side.transfer(ecosystem, 1_000e18);
        c.token = side;
        vm.etch(safe, hex"00"); // the Safe is a contract; the recipe and the promotion check it has code
        vm.createDir(SidequestOutput.candidateDir(vm), true); // gitignored: absent on a clean checkout
        (arbitrator, arbitratorPk) = makeAddrAndKey("arbiter");
        c.clocks = SidequestClocks.production();
        c.network = "local";
        c.chainId = block.chainid;
        c.admin = admin;
        c.attester = attester;
        c.identity = IERC8004Identity(address(new MockIdentity()));
        c.reputation = IERC8004Reputation(address(new MockReputation()));
        c.safe = safe;
        c.defaultArbitrator = arbitrator;
        c.margin = 1 days;
        c.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        c.bps = [uint16(3000), 1000, 300, 100];
        c.feeTreasury = safe;
        driver = new RecipeDriver();
        driver.configure(c);
    }

    function _runWithThirdPartyBetweenSteps() internal returns (SidequestRecipe.Deployed memory d) {
        driver.step(0);
        d = driver.deployed();
        // SIDE exists before the recipe and the recipe mints none.
        assertEq(address(d.factory), address(side));
        assertEq(side.totalSupply(), 1_000_000_000e18);
        driver.step(1);
        driver.step(2);
        d = driver.deployed();
        // A SIDE holder tries to stake ahead of the bootstrap; a donation lands but changes nothing.
        vm.startPrank(ecosystem);
        d.factory.approve(address(d.vault), 1);
        vm.expectRevert(IStakeVault.NotBootstrapped.selector);
        d.vault.delegate(ecosystem, 1);
        d.factory.transfer(address(d.vault), 1);
        vm.stopPrank();
        driver.step(3);
        d = driver.deployed();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.holding.setEvaluator(stranger);
        ISidequestHolding.PublishParams memory early;
        vm.prank(stranger);
        vm.expectRevert(ISidequestHolding.EvaluatorNotSet.selector);
        d.holding.publish(early);
        driver.step(4);
        d = driver.deployed();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.evaluator.setVerifier(stranger, true);
        driver.step(5);
        // Wired but not yet authorized in the vault: nothing can be published, even unbonded.
        _publishRefused(d);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.vault.bootstrapHolding(stranger);
        driver.step(6);
        driver.step(7);
        d = driver.deployed();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.vault.acceptOwnership();
    }

    function _publishRefused(SidequestRecipe.Deployed memory d) internal {
        MockPaymentToken usd = new MockPaymentToken("USD", "USD");
        usd.mint(stranger, 1e6);
        uint48 deadline = uint48(vm.getBlockTimestamp() + 1 hours);
        ISidequestHolding.PublishParams memory p;
        (p.policyHash, p.token, p.reward, p.deliveryDeadline) =
        (keccak256("early"), IERC20(address(usd)), 1e6, deadline);
        (p.reviewWindow, p.disputeWindow, p.arbitrationWindow) = (1 hours, 1 hours, 12 hours);
        p.creatorBond = c.minimumCreatorBond;
        p.expiredAt = deadline + 1 hours + 1 hours + 12 hours + 1 days;
        vm.startPrank(stranger);
        usd.approve(address(d.holding), 1e6);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        d.holding.publish(p);
        vm.stopPrank();
    }

    function _accept(SidequestRecipe.Deployed memory d) internal {
        vm.startPrank(safe);
        d.vault.acceptOwnership();
        d.fees.acceptOwnership();
        d.holding.acceptOwnership();
        d.evaluator.acceptOwnership();
        vm.stopPrank();
    }

    function test_recipe_stepsWithThirdPartyGaps_handover() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        assertEq(d.vault.owner(), admin, "handover is not complete until the Safe accepts");
        assertEq(d.vault.pendingOwner(), safe);
        _accept(d);
        assertEq(d.vault.owner(), safe);
        assertEq(d.fees.owner(), safe);
        assertEq(d.holding.owner(), safe);
        assertEq(d.evaluator.owner(), safe);

        // A fresh core: the Safe holds both roles, the deployer none, fees 0 to the Safe.
        assertTrue(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(d.core.hasRole(d.core.ADMIN_ROLE(), safe));
        assertFalse(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(d.core.hasRole(d.core.ADMIN_ROLE(), admin));
        assertEq(d.core.platformFeeBP(), 0);
        assertEq(d.core.evaluatorFeeBP(), 0);
        bytes32 adminRole = d.core.ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, adminRole)
        );
        d.core.pause();

        // SIDE: the configured token, which the deploy neither minted nor moved.
        assertEq(address(d.vault.factory()), address(side));
        assertEq(side.totalSupply(), 1_000_000_000e18);
        assertEq(side.balanceOf(admin), 1_000_000_000e18 - 1_000e18);
        assertEq(side.balanceOf(address(d.vault)), 1, "only the test donation");

        // Wiring.
        assertEq(d.holding.evaluator(), address(d.evaluator));
        assertTrue(d.evaluator.verifiers(attester));
        assertTrue(d.vault.isHolding(address(d.holding)));
        assertEq(d.holding.defaultArbitrator(), arbitrator);
        assertEq(d.fees.treasury(), safe);
        assertEq(d.fees.feeBps(10_000e18), 1000);
    }

    /// @dev The fresh deployment runs one hire end to end.
    function test_recipe_oneHire() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        _accept(d);
        (address creator, uint256 creatorPk) = makeAddrAndKey("creator");
        (address worker, uint256 workerPk) = makeAddrAndKey("worker");
        MockIdentity(address(c.identity)).setAgentWallet(7, worker);
        MockPaymentToken usd = new MockPaymentToken("USD", "USD");
        usd.mint(creator, 100e6);
        vm.prank(admin);
        d.factory.transfer(creator, c.minimumCreatorBond);
        vm.startPrank(creator);
        d.factory.approve(address(d.vault), c.minimumCreatorBond);
        d.vault.delegate(creator, c.minimumCreatorBond);
        vm.stopPrank();
        vm.prank(admin);
        d.factory.transfer(worker, 20_000e18);
        vm.startPrank(worker);
        d.factory.approve(address(d.vault), type(uint256).max);
        d.vault.delegate(worker, 20_000e18);
        vm.stopPrank();

        uint48 deadline = uint48(vm.getBlockTimestamp() + 7 days);
        ISidequestHolding.PublishParams memory p = ISidequestHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256("m"),
            policyHash: keccak256("p"),
            token: IERC20(address(usd)),
            reward: 100e6,
            creatorBond: c.minimumCreatorBond,
            workerBond: 10e18,
            deliveryDeadline: deadline,
            expiredAt: deadline + 1 days + 1 days + 1 days + 1 days,
            reviewWindow: 1 days,
            disputeWindow: 1 days,
            arbitrationWindow: 1 days
        });
        vm.startPrank(creator);
        usd.approve(address(d.holding), 100e6);
        uint256 jobId = d.holding.publish(p);
        vm.stopPrank();

        ISidequestHolding.Selection memory sel =
            ISidequestHolding.Selection(jobId, worker, 7, keccak256("p"), deadline - 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, d.holding.selectionDigest(sel));
        (, uint256 fee, uint256 net) = d.holding.quoteActivation(jobId, worker);
        assertEq(fee, 10e6, "20k staked: the 10 % tier");
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(d.core, workerPk, worker, jobId, address(usd), net);
        vm.prank(worker);
        d.holding.activate(sel, abi.encodePacked(r, s, v), auth);
        vm.prank(worker);
        d.core.submit(jobId, keccak256("work"), "");
        vm.prank(creator);
        d.evaluator.accept(jobId);
        d.holding.settle(jobId);
        assertEq(usd.balanceOf(worker), net);
        assertEq(usd.balanceOf(safe), fee);
        assertEq(d.vault.reservedOf(worker), 0);
    }

    function _budgetAuth(
        ERC8183WithAuthorization core,
        uint256 pk,
        address signer,
        uint256 jobId,
        address token,
        uint256 amount
    ) internal view returns (ERC8183WithAuthorization.Authorization memory) {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                signer,
                jobId,
                token,
                amount,
                keccak256(""),
                uint72(1),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return ERC8183WithAuthorization.Authorization(signer, 1, deadline, abi.encodePacked(r, s, v));
    }

    function test_recipe_checkRefusals() public {
        SidequestRecipe.Config memory bad = c;
        bad.safe = address(0);
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "zero address"));
        driver.configure(bad);
        bad = c;
        bad.chainId = 1;
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, 1, block.chainid));
        driver.configure(bad);
        bad = c;
        bad.safe = makeAddr("no-code-safe");
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "safe has no code"));
        driver.configure(bad);
        bad = c;
        bad.thresholds[3] = 1_000_000e18;
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "threshold above supply"));
        driver.configure(bad);
        // SIDE must exist before the deploy, with 18 decimals and exactly the launcher's 1e9 supply.
        bad = c;
        bad.token = IFactory(makeAddr("no-code-token"));
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "SIDE has no code"));
        driver.configure(bad);
        bad = c;
        bad.token = IFactory(address(new MockPaymentToken("USD", "USD")));
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "SIDE decimals"));
        driver.configure(bad);
        bad = c;
        vm.mockCall(address(side), abi.encodeWithSignature("totalSupply()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "SIDE supply"));
        driver.configure(bad);
        vm.clearMockedCalls();
        bad = c;
        bad.defaultArbitrator = admin;
        vm.expectRevert(
            abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "arbitrator must not be the deployer")
        );
        driver.configure(bad);
    }

    /// @dev Horizon review HR-002: windows and margin that fill the unstake delay leave no bonded hire possible.
    function test_recipe_checkRefusesClocksWithNoBondedHire() public {
        SidequestRecipe.Config memory bad = c;
        uint256 floor = uint256(c.clocks.minReviewWindow) + c.clocks.minDisputeWindow + c.clocks.minArbitrationWindow
            + c.margin + 1 hours;
        bad.clocks.unstakeDelay = uint48(floor - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestRecipe.BadConfig.selector, "clocks leave no bonded hire inside the unstake delay"
            )
        );
        driver.configure(bad);
        bad = c;
        bad.margin = uint48(c.clocks.unstakeDelay);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestRecipe.BadConfig.selector, "clocks leave no bonded hire inside the unstake delay"
            )
        );
        driver.configure(bad);
        bad = c;
        bad.clocks.unstakeDelay = uint48(floor);
        driver.configure(bad);
    }

    /// @dev LAUNCH-AUDIT-FIX-001: on chain 143 the v1 default arbitrator is `roles.arbitrator` and no retired 1 Oct key;
    ///      a fresh pair deploys a Holding whose default arbitrator is that role.
    function test_recipe_mainnetDefaultArbitratorIsTheFreshRole() public {
        vm.chainId(143);
        SidequestRecipe.Config memory m = c;
        m.chainId = 143;
        address fresh = makeAddr("fresh-arbiter");
        address[3] memory old = SidequestRecipe.retiredKeys();

        m.arbitrator = fresh;
        m.defaultArbitrator = makeAddr("another-fresh-arbiter");
        vm.expectRevert(
            abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "defaultArbitrator is not roles.arbitrator")
        );
        driver.configure(m);
        m.arbitrator = address(0); // a config without roles.arbitrator
        m.defaultArbitrator = fresh;
        vm.expectRevert(
            abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "defaultArbitrator is not roles.arbitrator")
        );
        driver.configure(m);
        for (uint256 i; i < 3; ++i) {
            m.arbitrator = fresh; // a rotated role, a stale default
            m.defaultArbitrator = old[i];
            vm.expectRevert(
                abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "defaultArbitrator is a retired 1 Oct key")
            );
            driver.configure(m);
            m.arbitrator = old[i]; // neither rotated
            vm.expectRevert(
                abi.encodeWithSelector(SidequestRecipe.BadConfig.selector, "defaultArbitrator is a retired 1 Oct key")
            );
            driver.configure(m);
        }

        m.arbitrator = fresh;
        m.defaultArbitrator = fresh;
        RecipeDriver mainnet = new RecipeDriver();
        mainnet.configure(m);
        for (uint256 i; i < 8; ++i) {
            mainnet.step(i);
        }
        assertEq(mainnet.deployed().holding.defaultArbitrator(), fresh);
    }

    /// @dev Off mainnet the default arbitrator is not tied to roles.arbitrator.
    function test_recipe_testnetDefaultArbitratorIsFree() public {
        SidequestRecipe.Config memory t = c;
        t.arbitrator = makeAddr("some-role");
        driver.configure(t);
        t.defaultArbitrator = SidequestRecipe.retiredKeys()[2];
        driver.configure(t);
    }

    /// @dev The recipe's retired keys are the API preflight's RETIRED_ROLE_ADDRESSES, and there are three of each.
    function test_recipe_retiredKeysMatchTheApiDenylist() public view {
        string memory api = vm.readFile(string.concat(vm.projectRoot(), "/../apps/api/src/prod-config.ts"));
        uint256 start = vm.indexOf(api, "export const RETIRED_ROLE_ADDRESSES = [");
        uint256 end = vm.indexOf(api, "] as const");
        assertTrue(start < end && end != type(uint256).max, "no RETIRED_ROLE_ADDRESSES in prod-config.ts");
        bytes memory list = new bytes(end - start);
        for (uint256 i; i < list.length; ++i) {
            list[i] = bytes(api)[start + i];
        }
        string[] memory quoted = vm.split(string(list), "'");
        assertEq(quoted.length, 7, "prod-config.ts lists other than three retired keys");
        address[3] memory keys = SidequestRecipe.retiredKeys();
        for (uint256 i; i < 3; ++i) {
            assertEq(vm.parseAddress(quoted[2 * i + 1]), keys[i]);
        }
    }

    // ------------------------------------------------------------------------------------------
    // The D1 record
    // ------------------------------------------------------------------------------------------

    function _temp(string memory name, string memory json) internal returns (string memory path) {
        path = string.concat(vm.projectRoot(), "/config/.test-", name, ".json");
        vm.writeFile(path, json);
    }

    /// @dev The shipped mainnet config as an unpromoted record (`.deployment` reset to `{}`), so these tests hold before
    ///      and after the coordinator fills R2 and commits the real promotion (LAUNCH-AUDIT-FIX-002).
    function _mainnetTemp(string memory name) internal returns (string memory path) {
        path = _temp(name, vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json")));
        vm.writeJson("{}", path, ".deployment");
        vm.writeJson(
            '{"maxMinimumCreatorBond":100000000000000000000000,"unfilledForfeitBps":2500,"minimumCreatorBond":10000000000000000000000}',
            path,
            ".sidequest"
        );
    }

    function test_output_testnetShape_recordsFreshCoreAndPair() public {
        c.clocks = SidequestClocks.Config(120, 120, 300, 259200, 262800, 300, 1800);
        driver.configure(c);
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory shipped = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory path = _temp("testnet", shipped);
        string memory real = UnpromotedTestnet.write(vm, path, shipped);
        SidequestOutput.write(vm, path, d, safe, 122, 123);
        string memory out = vm.readFile(path);
        vm.removeFile(path);

        assertEq(vm.parseJsonAddress(out, ".deployment.core"), address(d.core));
        assertEq(vm.parseJsonUint(out, ".deployment.block"), 122);
        assertEq(vm.parseJsonAddress(out, ".deployment.factory"), address(d.factory));
        assertEq(vm.parseJsonAddress(out, ".deployment.sidequest.vault"), address(d.vault));
        assertEq(vm.parseJsonAddress(out, ".deployment.sidequest.factory"), address(side));
        assertFalse(vm.keyExistsJson(out, ".deployment.sidequest.miningReserve"), "no mining in the record");
        assertFalse(vm.keyExistsJson(out, ".deployment.sidequest.t0"), "no mining genesis in the record");
        assertEq(vm.parseJsonUint(out, ".deployment.sidequest.block"), 123);
        assertEq(vm.parseJsonAddress(out, ".deployment.sidequest.safe"), safe, "D5");
        _assertOutputClocks(out, c.clocks);
        assertEq(vm.parseJsonString(out, ".deployment.main.kind"), "sidequest-v1");
        assertEq(vm.parseJsonAddress(out, ".deployment.main.holding"), address(d.holding));
        assertTrue(vm.parseJsonBool(out, ".deployment.main.openTokens"));
        assertEq(vm.parseJsonKeys(out, ".deployment").length, 7, "only v1 deployment metadata");
        assertEq(
            keccak256(abi.encode(vm.parseJsonAddressArray(out, ".deployment.rewardTokens"))),
            keccak256(abi.encode(vm.parseJsonAddressArray(real, ".deployment.rewardTokens")))
        );
        // Inputs are untouched.
        assertEq(vm.parseJsonAddress(out, ".roles.admin"), vm.parseJsonAddress(real, ".roles.admin"));

        // A second v1 record is refused.
        path = _temp("testnet2", out);
        vm.expectRevert(SidequestOutput.AlreadyDeployed.selector);
        this.writeExternal(path, d);
        vm.removeFile(path);
    }

    function test_output_shippedPromotedTestnet_refusesAnotherDeployment() public {
        string memory shipped = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        if (!vm.keyExistsJson(shipped, ".deployment.sidequest")) return vm.skip(true);
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _temp("testnet-promoted-guard", shipped);
        vm.expectRevert(SidequestOutput.AlreadyDeployed.selector);
        this.writeExternal(path, d);
        assertEq(vm.readFile(path), shipped, "guard preserves the promoted record");
        vm.removeFile(path);
    }

    function test_output_mainnetShape() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory path = _mainnetTemp("mainnet");
        SidequestOutput.write(vm, path, d, safe, 456, 457);
        string memory out = vm.readFile(path);
        vm.removeFile(path);
        assertEq(vm.parseJsonAddress(out, ".deployment.core"), address(d.core));
        assertEq(vm.parseJsonUint(out, ".deployment.block"), 456);
        assertEq(vm.parseJsonUint(out, ".deployment.sidequest.block"), 457);
        assertEq(vm.parseJsonString(out, ".deployment.main.kind"), "sidequest-v1");
        assertEq(vm.parseJsonKeys(out, ".deployment").length, 7, "only v1 deployment metadata");
        assertEq(vm.parseJsonString(out, ".deployment.network"), "monad-mainnet");
        _assertOutputClocks(out, SidequestClocks.production());
        // LAUNCH-AUDIT-004: an unpromoted config has knownTokens only; the record carries USDC as its reward token.
        address[] memory rewards = vm.parseJsonAddressArray(out, ".deployment.rewardTokens");
        assertEq(rewards.length, 1);
        assertEq(rewards[0], vm.parseJsonAddress(real, ".x402.usdc"));
        assertEq(rewards[0], vm.parseJsonAddressArray(real, ".knownTokens")[0]);
    }

    function _assertOutputClocks(string memory out, SidequestClocks.Config memory clocks) internal pure {
        string memory p = ".deployment.sidequest.clocks";
        assertEq(vm.parseJsonKeys(out, p).length, 7, "complete promoted clock tuple");
        assertEq(vm.parseJsonUint(out, string.concat(p, ".minReviewWindow")), clocks.minReviewWindow);
        assertEq(vm.parseJsonUint(out, string.concat(p, ".minDisputeWindow")), clocks.minDisputeWindow);
        assertEq(vm.parseJsonUint(out, string.concat(p, ".minArbitrationWindow")), clocks.minArbitrationWindow);
        assertEq(vm.parseJsonUint(out, string.concat(p, ".unstakeDelay")), clocks.unstakeDelay);
        assertEq(vm.parseJsonUint(out, string.concat(p, ".holdingDelay")), clocks.holdingDelay);
        assertEq(vm.parseJsonUint(out, string.concat(p, ".feeDelay")), clocks.feeDelay);
        assertEq(vm.parseJsonUint(out, string.concat(p, ".proposalGrace")), clocks.proposalGrace);
    }

    /// @dev Each changed input must refuse before writing. A copied input would silently pass all seven cases.
    function test_output_eachInputClockMismatch_preservesConfig() public {
        c.clocks = SidequestClocks.Config(120, 120, 300, 259200, 262800, 300, 1800);
        driver.configure(c);
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory shipped = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        string memory path = _temp("clock-mismatch", shipped);
        string memory fixture = UnpromotedTestnet.write(vm, path, shipped);
        string[] memory names = vm.parseJsonKeys(fixture, ".sidequest.clocks");
        assertEq(names.length, 7);
        for (uint256 i; i < names.length; ++i) {
            vm.writeFile(path, fixture);
            string memory p = string.concat(".sidequest.clocks.", names[i]);
            vm.writeJson(vm.toString(vm.parseJsonUint(fixture, p) + 1), path, p);
            string memory before = vm.readFile(path);
            vm.expectRevert(SidequestOutput.ClockMismatch.selector);
            this.writeExternal(path, d);
            assertEq(vm.readFile(path), before, "mismatched clocks must not mutate config");
        }
        vm.removeFile(path);
    }

    /// @dev The proposal grace repeated on FeeSchedule must agree with the vault's before promotion.
    function test_output_duplicateGetterMismatch_preservesConfig() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _mainnetTemp("clock-duplicates");
        string memory before = vm.readFile(path);
        vm.mockCall(address(d.fees), abi.encodeWithSignature("PROPOSAL_GRACE()"), abi.encode(uint256(123)));
        vm.expectRevert(SidequestOutput.ClockMismatch.selector);
        this.writeExternal(path, d);
        assertEq(vm.readFile(path), before);
        vm.clearMockedCalls();
        vm.removeFile(path);
    }

    function test_output_mainnetShape_refusesFastClocksEvenWhenInputMatches() public {
        c.clocks = SidequestClocks.Config(120, 120, 300, 259200, 262800, 300, 1800);
        driver.configure(c);
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _mainnetTemp("clock-mainnet-fast");
        vm.writeJson(
            '{"minReviewWindow":120,"minDisputeWindow":120,"minArbitrationWindow":300,"unstakeDelay":600,"holdingDelay":900,"feeDelay":300,"proposalGrace":1800}',
            path,
            ".sidequest.clocks"
        );
        string memory before = vm.readFile(path);
        vm.expectRevert(SidequestOutput.ClockMismatch.selector);
        this.writeExternal(path, d);
        assertEq(vm.readFile(path), before);
        vm.removeFile(path);
    }

    /// @dev LAUNCH-AUDIT-004: on mainnet a reward list without USDC refuses before anything is written; without an
    ///      explicit list the known tokens (USDC, and SIDE for Sidequest's own spending) become it; a list is kept as is.
    function test_output_mainnetRewardTokensKeepUsdc() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory usdc = vm.toString(vm.parseJsonAddress(real, ".x402.usdc"));

        string memory path = _mainnetTemp("rewards-no-usdc");
        vm.writeJson('{"rewardTokens":["0x0000000000000000000000000000000000000Bad"]}', path, ".deployment");
        vm.expectRevert(SidequestOutput.MainnetRewardTokens.selector);
        this.writeExternal(path, d);
        vm.removeFile(path);

        path = _mainnetTemp("rewards-known-no-usdc");
        vm.writeJson('["0x0000000000000000000000000000000000000Bad"]', path, ".knownTokens");
        vm.expectRevert(SidequestOutput.MainnetRewardTokens.selector);
        this.writeExternal(path, d);
        vm.removeFile(path);

        path = _mainnetTemp("rewards-two-known");
        vm.writeJson(string.concat('["', usdc, '","', vm.toString(address(side)), '"]'), path, ".knownTokens");
        this.writeExternal(path, d);
        address[] memory known = vm.parseJsonAddressArray(vm.readFile(path), ".deployment.rewardTokens");
        vm.removeFile(path);
        assertEq(known.length, 2);
        assertEq(known[1], address(side), "SIDE is a reward token for Sidequest's own spending");

        path = _mainnetTemp("rewards-kept");
        vm.writeJson(
            string.concat('{"rewardTokens":["0x0000000000000000000000000000000000000Bad","', usdc, '"]}'),
            path,
            ".deployment"
        );
        this.writeExternal(path, d);
        address[] memory kept = vm.parseJsonAddressArray(vm.readFile(path), ".deployment.rewardTokens");
        vm.removeFile(path);
        assertEq(kept.length, 2);
        assertEq(vm.toString(kept[1]), usdc);
    }

    function test_output_refusesUnknownKeys() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string[6] memory keys = ["surprise", "legacy", "demo", "fast", "poolFactory", "stacksBlock"];
        for (uint256 i; i < keys.length; ++i) {
            string memory json = string.concat('{"network":"x","deployment":{"', keys[i], '":{}}}');
            string memory path = _temp("unknown", json);
            vm.expectRevert(abi.encodeWithSelector(SidequestOutput.UnknownKey.selector, "deployment", keys[i]));
            this.writeExternal(path, d);
            assertEq(vm.readFile(path), json, "a refused promotion never rewrites input");
            vm.removeFile(path);
        }
    }

    /// @dev The `sidequest` input block the coordinator writes (schema in SURFACE.md), parsed by `load`.
    function test_load_sidequestInputBlock() public {
        string memory base = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory block_ = string.concat(
            '{"safe":"0x00000000000000000000000000000000000000a1",',
            '"defaultArbitrator":"0x00000000000000000000000000000000000000a2","margin":86400,"maxMinimumCreatorBond":100000000000000000000000,"unfilledForfeitBps":2500,"minimumCreatorBond":10000000000000000000000,',
            '"schedule":{"thresholds":[0,10000,100000,1000000],"bps":[3000,1000,300,100],',
            '"treasury":"0x00000000000000000000000000000000000000a1"},',
            '"token":"0x00000000000000000000000000000000000000a3"}'
        );
        string memory path = string.concat(vm.projectRoot(), "/config/.test-load.json");
        vm.writeFile(path, base);
        vm.writeJson(block_, path, ".sidequest");
        string memory name = ".test-load";
        SidequestRecipe.Config memory l = SidequestRecipe.load(vm, name);
        assertEq(
            keccak256(abi.encode(l.clocks)),
            keccak256(abi.encode(SidequestClocks.production())),
            "absent clocks default to production"
        );
        vm.removeFile(path);
        assertEq(l.safe, address(0xa1));
        assertEq(l.defaultArbitrator, address(0xa2));
        assertEq(l.margin, 86400);
        assertEq(l.thresholds[3], 1_000_000);
        assertEq(l.bps[1], 1000);
        assertEq(l.feeTreasury, address(0xa1));
        assertEq(address(l.token), address(0xa3));
        assertEq(l.admin, vm.parseJsonAddress(base, ".roles.admin"));
    }

    function guardExt(string memory json, bool sends) external view returns (uint256) {
        return SidequestRecipe.guardChain(vm, json, sends);
    }

    /// @dev Review C10-001: a testnet config on a mainnet RPC is refused before anything is sent or read; chain 143
    ///      needs MAINNET_GO=yes to send, judged by the connected chain; a read-only check needs only the match.
    function test_guardChain_rpcMustMatchTheConfig() public {
        string memory testnet = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory mainnet = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        vm.setEnv("MAINNET_GO", "");
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, 10143, 143));
        this.guardExt(testnet, true);
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, 10143, 143));
        this.guardExt(testnet, false);
        vm.expectRevert(SidequestRecipe.MainnetNotGo.selector);
        this.guardExt(mainnet, true);
        assertEq(this.guardExt(mainnet, false), 143);
        vm.setEnv("MAINNET_GO", "yes");
        assertEq(this.guardExt(mainnet, true), 143);
        vm.setEnv("MAINNET_GO", "");
        vm.chainId(10143);
        assertEq(this.guardExt(testnet, true), 10143);
        vm.expectRevert(abi.encodeWithSelector(SidequestRecipe.WrongChain.selector, 143, 10143));
        this.guardExt(mainnet, true);
    }

    function writeExternal(string memory path, SidequestRecipe.Deployed memory d) external {
        SidequestOutput.write(vm, path, d, safe, 1, 1);
    }

    // ------------------------------------------------------------------------------------------
    // Promotion (review C8-001): candidate, live verification, receipt blocks, idempotency
    // ------------------------------------------------------------------------------------------

    function verifyExternal(SidequestRecipe.Config memory cc, SidequestRecipe.Deployed memory d) external view {
        SidequestVerify.verify(cc, d);
    }

    function blocksExternal(string memory path, SidequestRecipe.Deployed memory d)
        external
        view
        returns (uint256, uint256)
    {
        return SidequestVerify.blocks(vm, path, d);
    }

    function _expectNotLive(SidequestRecipe.Config memory cc, SidequestRecipe.Deployed memory d, string memory what)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, what));
        this.verifyExternal(cc, d);
    }

    function test_promotion_candidateRoundTrip() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = string.concat(vm.projectRoot(), "/broadcast/sidequest/.test.candidate.json");
        SidequestOutput.writeCandidate(vm, path, block.chainid, d, safe);
        (SidequestRecipe.Deployed memory r, address s, uint256 chainId) = SidequestOutput.readCandidate(vm, path);
        vm.removeFile(path);
        assertEq(chainId, block.chainid);
        assertEq(s, safe);
        assertEq(address(r.core), address(d.core));
        assertEq(address(r.factory), address(d.factory));
        assertEq(address(r.fees), address(d.fees));
        assertEq(address(r.vault), address(d.vault));
        assertEq(address(r.holding), address(d.holding));
        assertEq(address(r.evaluator), address(d.evaluator));
    }

    /// @dev Pending and accepted handovers both verify; every gap the promotion must catch is refused.
    function test_promotion_verifyLiveState() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        this.verifyExternal(c, d);
        _accept(d);
        this.verifyExternal(c, d);

        SidequestRecipe.Deployed memory bad = driver.deployed(); // a fresh copy, not an alias of d
        bad.holding = SidequestHolding(stranger);
        _expectNotLive(c, bad, "holding code");

        SidequestRecipe.Config memory cc = c;
        cc.defaultArbitrator = stranger;
        _expectNotLive(cc, d, "holding.defaultArbitrator");

        // The vault stakes another token than the configured SIDE, or SIDE's supply is not the launch supply.
        cc = c;
        cc.token = IFactory(address(new LaunchToken(admin)));
        _expectNotLive(cc, d, "SIDE token");
        vm.mockCall(address(side), abi.encodeWithSignature("totalSupply()"), abi.encode(uint256(1)));
        _expectNotLive(c, d, "SIDE supply");
        vm.clearMockedCalls();
    }

    /// @dev Review C8-002: SIDE donated to every deployed contract cannot block promotion.
    function test_promotion_dustDoesNotBlock() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        vm.startPrank(ecosystem);
        d.factory.transfer(address(d.fees), 1);
        d.factory.transfer(address(d.holding), 1);
        d.factory.transfer(address(d.evaluator), 1);
        d.factory.transfer(address(d.core), 1);
        vm.stopPrank();
        this.verifyExternal(c, d);
    }

    function test_promotion_refusesAnIncompleteHandover() public {
        for (uint256 i; i < 7; ++i) {
            driver.step(i);
        }
        SidequestRecipe.Deployed memory d = driver.deployed();
        // Step 7 (handover) not sent: the deployer still holds the core roles and every owner.
        _expectNotLive(c, d, "core admin role: safe");
    }

    function test_promotion_receiptBlocks() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = string.concat(vm.projectRoot(), "/broadcast/sidequest/.test-run.json");
        vm.writeFile(path, _runLog(d, "0x1", false));
        (uint256 coreBlock, uint256 sidequestBlock) = this.blocksExternal(path, d);
        assertEq(coreBlock, 0x101);
        assertEq(sidequestBlock, 0x100);

        vm.writeFile(path, _runLog(d, "0x0", false));
        vm.expectRevert(
            abi.encodeWithSelector(SidequestVerify.BadBroadcast.selector, "transaction without a successful receipt")
        );
        this.blocksExternal(path, d);

        vm.writeFile(path, _runLog(d, "0x1", true));
        vm.expectRevert(
            abi.encodeWithSelector(SidequestVerify.BadBroadcast.selector, "transaction without a successful receipt")
        );
        this.blocksExternal(path, d);
        vm.removeFile(path);
    }

    /// @dev A minimal forge run log: one CALL, then a CREATE for each deployed contract (the core proxy in block
    ///      0x101, the rest in 0x102); `dropLast` leaves the last transaction without a receipt. SIDE is not created by
    ///      the run.
    function _runLog(SidequestRecipe.Deployed memory d, string memory status, bool dropLast)
        internal
        view
        returns (string memory)
    {
        address[5] memory created =
            [address(d.core), address(d.fees), address(d.vault), address(d.holding), address(d.evaluator)];
        string memory txs = string.concat(
            '{"hash":"',
            vm.toString(bytes32(uint256(1000))),
            '","transactionType":"CALL","contractAddress":"',
            vm.toString(address(d.core)),
            '"}'
        );
        string memory receipts = string.concat(
            '{"transactionHash":"',
            vm.toString(bytes32(uint256(1000))),
            '","status":"',
            status,
            '","blockNumber":"0x100"}'
        );
        for (uint256 i; i < created.length; ++i) {
            string memory hash = vm.toString(bytes32(uint256(1001 + i)));
            txs = string.concat(
                txs,
                ',{"hash":"',
                hash,
                '","transactionType":"CREATE","contractAddress":"',
                vm.toString(created[i]),
                '"}'
            );
            if (dropLast && i == created.length - 1) continue;
            receipts = string.concat(
                receipts,
                ',{"transactionHash":"',
                hash,
                '","status":"0x1","blockNumber":"',
                i == 0 ? "0x101" : "0x102",
                '","logs":[]}'
            );
        }
        return string.concat('{"transactions":[', txs, '],"receipts":[', receipts, '],"pending":[]}');
    }

    function test_promotion_isIdempotent() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _mainnetTemp("promote");
        assertFalse(SidequestOutput.isPromoted(vm, vm.readFile(path), d, safe));
        SidequestOutput.write(vm, path, d, safe, 10, 11);
        string memory once = vm.readFile(path);
        assertTrue(SidequestOutput.isPromoted(vm, once, d, safe));
        SidequestRecipe.Deployed memory other = driver.deployed();
        other.vault = StakeVault(stranger);
        vm.expectRevert(SidequestOutput.AlreadyDeployed.selector);
        this.isPromotedExternal(once, other);
        vm.writeJson("604801", path, ".deployment.sidequest.clocks.proposalGrace");
        vm.expectRevert(SidequestOutput.AlreadyDeployed.selector);
        this.isPromotedExternal(vm.readFile(path), d);
        vm.writeFile(path, once);
        vm.writeJson(
            '{"minReviewWindow":3600,"minDisputeWindow":3600,"minArbitrationWindow":43200,"unstakeDelay":1209600,"holdingDelay":1814400,"feeDelay":259200,"proposalGrace":604801}',
            path,
            ".sidequest.clocks"
        );
        vm.expectRevert(SidequestOutput.AlreadyDeployed.selector);
        this.isPromotedExternal(vm.readFile(path), d);
        vm.removeFile(path);
    }

    function isPromotedExternal(string memory json, SidequestRecipe.Deployed memory d) external view returns (bool) {
        return SidequestOutput.isPromoted(vm, json, d, safe);
    }

    function test_promotion_readsEveryImmutableClock() public {
        SidequestRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        vm.mockCall(address(d.holding), abi.encodeWithSignature("MIN_REVIEW_WINDOW()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "holding.MIN_REVIEW_WINDOW"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.holding), abi.encodeWithSignature("MIN_DISPUTE_WINDOW()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "holding.MIN_DISPUTE_WINDOW"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.holding), abi.encodeWithSignature("MIN_ARBITRATION_WINDOW()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "holding.MIN_ARBITRATION_WINDOW"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.vault), abi.encodeWithSignature("UNSTAKE_DELAY()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "vault.UNSTAKE_DELAY"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.vault), abi.encodeWithSignature("HOLDING_DELAY()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "vault.HOLDING_DELAY"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.vault), abi.encodeWithSignature("PROPOSAL_GRACE()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "vault.PROPOSAL_GRACE"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.fees), abi.encodeWithSignature("DELAY()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "fees.DELAY"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
        vm.mockCall(address(d.fees), abi.encodeWithSignature("PROPOSAL_GRACE()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(SidequestVerify.NotLive.selector, "fees.PROPOSAL_GRACE"));
        this.verifyExternal(c, d);
        vm.clearMockedCalls();
    }
}
