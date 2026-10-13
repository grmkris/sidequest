// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SidequestRecipe} from "../script/SidequestRecipe.sol";

/// @notice PROD-GATE-007: `docs/mainnet-runbook.md` is the v1 launch, in the order R7 (`script/rehearse-launch.sh`)
///         runs it, with the custody readback and the drained-then-open deploy gates, and no legacy deploy path. Each
///         script and entry point it names exists. Source-level only: R7 is what executes the sequence.
contract MainnetRunbookTest is Test {
    string internal doc;
    string internal r7;
    string internal kit;

    /// The runbook's SafeAccept step: the launch kit on Kris's MacBook runs SafeAccept.s.sol from the owner keystore.
    string internal constant KIT_ACCEPT =
        "MAINNET_GO=yes NETWORK=monad-mainnet contracts/script/launch-kit.sh accept send";

    function setUp() public {
        doc = vm.readFile(string.concat(vm.projectRoot(), "/../docs/mainnet-runbook.md"));
        r7 = vm.readFile(string.concat(vm.projectRoot(), "/script/rehearse-launch.sh"));
        kit = vm.readFile(string.concat(vm.projectRoot(), "/script/launch-kit.sh"));
        kit = string.concat(kit, "\n", vm.readFile(string.concat(vm.projectRoot(), "/script/launch-kit-journal.sh")));
    }

    /// The forge steps both documents share, in launch order.
    function _sharedSteps() internal pure returns (string[] memory s) {
        s = new string[](4);
        s[0] = "MAINNET_GO=yes forge script script/DeploySidequest.s.sol";
        s[1] = "forge script script/PromoteSidequest.s.sol";
        s[2] = "MAINNET_GO=yes forge script script/SafeAccept.s.sol";
        s[3] = "forge script script/SafeAccept.s.sol --sig \"check()\"";
    }

    function test_runbookAndR7RunTheSameForgeSteps() public view {
        string[] memory runbook = _sharedSteps();
        runbook[2] = KIT_ACCEPT;
        _inOrder(doc, runbook, "runbook");
        _inOrder(r7, _sharedSteps(), "rehearse-launch.sh");
        // The kit journals the same per-target Safe calls R7 broadcasts through SafeAccept.s.sol, then reads owners.
        string[] memory accept = new string[](3);
        accept[0] = "queue_tx owner \"$safe\" 0 \"$EXEC\" \"$target\" 0 \"$data\"";
        accept[1] = "execute_plan";
        accept[2] = "forge script script/SafeAccept.s.sol --sig 'check()'";
        _inOrder(kit, accept, "launch-kit.sh");
    }

    /// Launch review #5: signed transaction bytes and operation identity are durable before publish, and retries
    /// reconcile receipts/nonce before replaying the same bytes. Dynamic command inputs are never rebuilt on a retry.
    function test_launchKitPersistsBeforePublishAndReconcilesBeforeRetry() public view {
        assertFalse(vm.contains(kit, "cast send --rpc-url"), "unjournaled launch-kit send");
        assertTrue(vm.contains(kit, "cast mktx --rpc-url \"$RPC\" --chain \"$CHAIN\" --nonce \"$nonce\""));
        assertTrue(vm.contains(kit, "journal_save \"$file\""), "signed transaction not persisted");
        assertTrue(vm.contains(kit, "cast publish --rpc-url \"$RPC\" --json \"$raw\""));
        assertTrue(vm.contains(kit, "cast receipt --async --rpc-url \"$RPC\" --json \"$hash\""));
        assertTrue(vm.contains(kit, "cast nonce --rpc-url \"$RPC\" --block latest \"$from\""));
        assertTrue(vm.contains(kit, "saved operation differs"));
        assertTrue(vm.contains(kit, "sender nonce $nonce is spent"));
        assertTrue(vm.contains(doc, "KIT_OPERATION"), "runbook does not explain intentional repeated operations");
    }

    /// 12 Oct: the Safe owner, creator and exit-test keys sign on Kris's MacBook through the kit. Every password read is a
    /// Keychain prompt (no trusted app), a mainnet send needs MAINNET_GO=yes and refuses agent-made keystores, agents
    /// cannot run setup, and no raw key is ever passed.
    function test_launchKitSignsFromPromptedKeystores() public view {
        string[7] memory needles = [
            "security add-generic-password -U -a sidequest -s \"sidequest-$1\" -l \"Sidequest $1 keystore\" -T \"\"",
            "[[ \"${MAINNET_GO:-}\" == yes ]]",
            "these keystores were made by an agent for a testnet dry run",
            "setup makes keys: Kris runs it himself in Terminal",
            "--keystore \"$KEYS/sidequest-$name\" --password-file \"$PWFILE\"",
            "$(nadfun api)",
            "version: \"V2\""
        ];
        for (uint256 i; i < needles.length; ++i) {
            assertTrue(vm.contains(kit, needles[i]), string.concat("launch-kit.sh lacks ", needles[i]));
        }
        assertFalse(vm.contains(kit, "--private-key"), "launch-kit.sh passes a raw key");
    }

    /// LAUNCH-AUDIT-CHAIN-001: every kit plan and send starts by binding its configured network to the selected RPC.
    function test_launchKitBindsEveryPlanAndSendToConfigChain() public view {
        assertTrue(vm.contains(kit, "chain_check()"), "launch kit has no RPC chain check");
        assertTrue(vm.contains(kit, "cast chain-id --rpc-url \"$RPC\""), "launch kit does not query the RPC chain");
        assertTrue(
            vm.contains(kit, "safe|token|move|accept|backing|exit|bond|fund|balances) chain_check"),
            "launch kit does not check before command dispatch"
        );
        assertTrue(vm.contains(kit, "go_check() {\n  chain_check"), "send path does not recheck the RPC chain");
        assertTrue(vm.contains(kit, "config chain $CHAIN ($NETWORK)"), "chain mismatch refusal omits config context");
    }

    /// LAUNCH-AUDIT-VERIFY-001: rerunning promotion is a live health check, not a stale idempotency shortcut.
    function test_repeatedPromotionRechecksTheVerifier() public view {
        string memory promote = vm.readFile(string.concat(vm.projectRoot(), "/script/PromoteSidequest.s.sol"));
        uint256 branch = vm.indexOf(promote, "if (SidequestOutput.isPromoted");
        uint256 verify = vm.indexOf(promote, "SidequestVerify.verify(c, d);");
        uint256 returned = vm.indexOf(promote, "return;");
        assertGt(branch, 0, "promotion has no already-promoted branch");
        assertGt(verify, branch, "already-promoted branch does not verify");
        assertGt(returned, verify, "promotion returns before the repeated verifier");
    }

    /// LAUNCH-AUDIT-ACCEPT-001: the documented accept plan is read-only on chain 143 and does not need MAINNET_GO;
    /// the separate send entry point still requires approval.
    function test_acceptPlanUsesReadOnlyChainGuard() public view {
        string memory accept = vm.readFile(string.concat(vm.projectRoot(), "/script/SafeAccept.s.sol"));
        assertTrue(vm.contains(kit, "--sig 'simulate()' --rpc-url \"$RPC\" --sender \"$owner\""));
        assertTrue(vm.contains(accept, "function simulate()"));
        assertTrue(vm.contains(accept, "simulate cannot broadcast"));
        assertTrue(vm.contains(accept, "SidequestRecipe.guardChain(vm, json, true)"), "send lost its approval guard");
        assertTrue(vm.contains(accept, "SidequestRecipe.guardChain(vm, json, false)"), "check() lost its read-only guard");
    }

    function test_runbookSequenceWithGates() public view {
        string memory live = "bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live";
        string[] memory s = new string[](18);
        // Before any SIDE reaches the Safe: no module and no guard, which would act outside the owners' signatures.
        s[0] = "getModulesPaginated(address,uint256)(address[],address)";
        s[1] = GUARD_SLOT;
        s[2] = "### 3.2 SIDE on nad.fun";
        s[3] = "MAINNET_GO=yes forge script script/DeploySidequest.s.sol";
        s[4] = "forge script script/PromoteSidequest.s.sol";
        s[5] = live;
        s[6] = "production launch gate refused";
        s[7] = KIT_ACCEPT;
        s[8] = "forge script script/SafeAccept.s.sol --sig \"check()\"";
        s[9] = live;
        s[10] = "Sidequest v1 production launch gate passed";
        // LAUNCH-AUDIT-003: the gate reads the reviewed Safe back against the artifact's pins.
        s[11] = "the reviewed Safe: storage slot 0 is the canonical SafeL2 singleton";
        // R4/G1: the 1-of-1 launch Safe goes to 2-of-3 by 20 Oct, in place, and the gate's pins follow.
        s[12] = "`addOwnerWithThreshold(address,uint256)`";
        s[13] = "PROD_ADMISSION_DRAIN=1 bun run deploy:prod";
        s[14] = "Post-deploy probes";
        s[15] = "bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --probe https://sidequest.exchange";
        s[16] = live;
        s[17] = "PROD_ADMISSION_DRAIN=0 bun run deploy:prod";
        _inOrder(doc, s, "runbook");
    }

    /// keccak256("guard_manager.guard.address"), Safe v1.4.1's guard storage slot.
    string internal constant GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

    /// LAUNCH-AUDIT-003: D16 itself reads the Safe's singleton, VERSION, owners, threshold, modules and guard against the
    /// artifact's pins; the artifact has the fields; R7 runs the gate with its own Safe's pins and shows the refusals.
    function test_launchGateReadsTheReviewedSafe() public view {
        string memory root = vm.projectRoot();
        string memory gate = vm.readFile(string.concat(root, "/../apps/api/src/prod-config.ts"));
        string[8] memory reads = [
            "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
            GUARD_SLOT,
            "function VERSION() view returns (string)",
            "function getOwners() view returns (address[])",
            "function getThreshold() view returns (uint256)",
            "function getModulesPaginated(address start, uint256 pageSize)",
            "safeOwners",
            "safeThreshold"
        ];
        for (uint256 i; i < reads.length; ++i) {
            assertTrue(vm.contains(gate, reads[i]), string.concat("prod-config.ts lacks ", reads[i]));
        }
        assertTrue(vm.contains(doc, "`deployment.sidequest.safeOwners`"), "runbook does not pin the Safe owners");
        assertTrue(vm.contains(doc, "`deployment.sidequest.safeThreshold`"), "runbook does not pin the Safe threshold");
        assertTrue(
            vm.contains(
                r7,
                "liveLaunchGate(config, rpcReader(process.argv[3]), RELAY_FLOOR_MAINNET, JSON.parse(process.argv[4]))"
            ),
            "R7 gate without a Safe policy"
        );
        assertTrue(
            vm.contains(r7, "launch:safe owners differ from the pinned set"),
            "R7 does not show a wrong owner pin refusing"
        );
        assertTrue(vm.contains(r7, "launch:safe has a guard set"), "R7 does not show a guard refusing");
    }

    /// LAUNCH-AUDIT-001: runbook §1.2's `sidequest` table is a complete recipe input. A fixture built only from its rows
    /// (path and type) loads through SidequestRecipe.load; without one row it does not. FIX-003: the fixture is set as the `sidequest` object of a scratch copy of the shipped record, so this
    /// holds whatever that record holds: no block before R2, R2's own block after (replaced here).
    function test_documentedSidequestInputLoads() public {
        (string memory json, uint256 rows) = _documentedSidequest("");
        assertEq(rows, 11, "runbook: the sidequest table lists the 11 fields load reads");

        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory path_ = string.concat(vm.projectRoot(), "/config/.test-schema.json");
        vm.writeFile(path_, real);
        vm.writeJson('{"safe":"0x0000000000000000000000000000000000000bad"}', path_, ".sidequest");
        string[2] memory bases = [real, vm.readFile(path_)]; // as shipped, and with an R2 sidequest block
        for (uint256 i; i < 2; ++i) {
            vm.writeFile(path_, bases[i]);
            vm.writeJson(json, path_, ".sidequest");
            SidequestRecipe.Config memory c = SidequestRecipe.load(vm, ".test-schema");
            assertEq(c.chainId, 143);
            assertEq(c.safe, address(uint160(0xa000 + 1)));
            assertEq(c.slashRecipient, address(uint160(0xa000 + 2)));
            assertEq(address(c.token), address(uint160(0xa000 + 11)), "the existing SIDE, the last row");
        }
        (string memory short,) = _documentedSidequest("margin");
        vm.writeFile(path_, real);
        vm.writeJson(short, path_, ".sidequest");
        vm.expectRevert();
        this.loadSchema();
        vm.removeFile(path_);
    }

    function loadSchema() external view returns (uint256) {
        return SidequestRecipe.load(vm, ".test-schema").chainId;
    }

    /// The §1.2 table as a `sidequest` object (one fixture value per type), without the field named `skip`.
    function _documentedSidequest(string memory skip) internal view returns (string memory json, uint256 rows) {
        string[] memory lines = vm.split(doc, "\n");
        json = "{";
        string memory group = "";
        bool first = true;
        bool firstInGroup;
        for (uint256 i; i < lines.length; ++i) {
            string memory line = vm.trim(lines[i]);
            if (vm.indexOf(line, "| `sidequest.") != 0) continue;
            string[] memory cells = vm.split(line, "|");
            string memory path = vm.replace(vm.replace(vm.trim(cells[1]), "`", ""), "sidequest.", "");
            string memory kind = vm.trim(cells[2]);
            // The recipe reads only address/uint inputs; retired bool options are not inputs.
            if (_eq(kind, "bool")) continue;
            string memory value = _fixtureValue(kind, ++rows);
            if (_eq(path, skip)) continue;
            string[] memory parts = vm.split(path, ".");
            if (parts.length == 1) {
                if (bytes(group).length > 0) json = string.concat(json, "}");
                group = "";
                json = string.concat(json, first ? "" : ",", '"', parts[0], '":', value);
            } else {
                assertEq(parts.length, 2, string.concat("runbook: unexpected sidequest field ", path));
                if (!_eq(group, parts[0])) {
                    if (bytes(group).length > 0) json = string.concat(json, "}");
                    json = string.concat(json, first ? "" : ",", '"', parts[0], '":{');
                    group = parts[0];
                    firstInGroup = true;
                }
                json = string.concat(json, firstInGroup ? "" : ",", '"', parts[1], '":', value);
                firstInGroup = false;
            }
            first = false;
        }
        json = string.concat(json, bytes(group).length > 0 ? "}}" : "}");
    }

    function _fixtureValue(string memory kind, uint256 row) internal pure returns (string memory) {
        if (_eq(kind, "address")) return string.concat('"', vm.toString(address(uint160(0xa000 + row))), '"');
        if (_eq(kind, "uint")) return "1";
        if (_eq(kind, "uint[4]")) return "[0,1,2,3]";
        revert(string.concat("runbook: unknown sidequest field type ", kind));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// LAUNCH-AUDIT-006: every command in the runbook's code blocks says where it runs and which RPC it reads. A
    /// `forge script` runs inside an explicit contracts subshell that sources ../.env.local itself; every forge script and
    /// chain-reading cast names --rpc-url; the session is declared bash (read -rsp, pwcheck).
    function test_commandsNameTheirCwdEnvAndRpc() public view {
        assertTrue(
            vm.contains(doc, "interactive **bash** session at the repo root. Start it with `bash`"),
            "no bash declaration"
        );
        string[] memory lines = vm.split(doc, "\n");
        bool inBlock;
        bool subshell;
        string memory command = "";
        uint256 checked;
        for (uint256 i; i < lines.length; ++i) {
            string memory line = vm.trim(lines[i]);
            if (vm.indexOf(line, "```") == 0) {
                inBlock = !inBlock;
                command = "";
                subshell = false;
                continue;
            }
            if (!inBlock) continue;
            if (vm.contains(line, "(cd contracts && set -a && . ../.env.local && set +a")) subshell = true;
            if (vm.contains(line, "forge script")) {
                assertTrue(subshell, string.concat("runbook: forge script outside the contracts subshell: ", line));
            }
            command = string.concat(command, " ", line);
            bytes memory b = bytes(line);
            if (b.length > 0 && b[b.length - 1] == "\\") continue; // a continued command
            bool reads = vm.contains(command, "forge script") || vm.contains(command, "cast call")
                || vm.contains(command, "cast storage") || vm.contains(command, "cast send")
                || vm.contains(command, "cast block-number");
            if (reads) {
                ++checked;
                assertTrue(
                    vm.contains(command, "--rpc-url"), string.concat("runbook: a read without --rpc-url: ", command)
                );
            }
            command = "";
            subshell = false;
        }
        assertGt(checked, 7, "runbook: expected the launch commands");
    }

    function test_runbookCarriesBudgetAndFunding() public view {
        string[5] memory needles = [
            "| nad.fun creation with the 5% dev buy |", // SIDE comes from the launcher, with the dev buy
            "| arbitrator | `roles.arbitrator` (a fresh R2 key) | 0.11 |", // LAUNCH-AUDIT-007: the cancellation reserve
            "RELAY_FLOOR_MAINNET",
            "| relay |",
            unicode"| 2-of-3 by 20 Oct: addOwnerWithThreshold ×2 |"
        ];
        for (uint256 i; i < needles.length; ++i) {
            assertTrue(vm.contains(doc, needles[i]), string.concat("runbook lacks ", needles[i]));
        }
    }

    function test_runbookHasNoLegacyPath() public view {
        // A raw key on a mainnet command line: keystores are mandatory there (--private-key is a testnet fallback).
        string[4] memory banned = ["node scripts/preflight-prod", "--adopt", "--force", "--private-key \"$"];
        for (uint256 i; i < banned.length; ++i) {
            assertFalse(vm.contains(doc, banned[i]), string.concat("runbook still names ", banned[i]));
        }
    }

    function test_mainnetSignsFromKeystores() public view {
        string[9] memory needles = [
            "cast wallet import sidequest-deployer --interactive",
            "--account sidequest-deployer --password-file ~/.config/sidequest/deployer.password",
            // The Safe owner, creator and exit-test keys: Kris makes them on the Mac, and every signature is his prompt.
            "NETWORK=monad-mainnet contracts/script/launch-kit.sh setup",
            KIT_ACCEPT,
            // KEYSTORE-SEC-002: an existing directory or file is tightened, and every signer is checked first.
            "chmod 700 ~/.config/sidequest",
            "rm -f ~/.config/sidequest/deployer.password",
            "chmod 600 ~/.config/sidequest/deployer.password",
            "pwcheck ~/.config/sidequest/deployer.password && \\",
            "click **Allow**, never **Always Allow**"
        ];
        for (uint256 i; i < needles.length; ++i) {
            assertTrue(vm.contains(doc, needles[i]), string.concat("runbook lacks ", needles[i]));
        }
    }

    /// KEYSTORE-SEC-001: no mainnet command anywhere it is documented passes a raw key; testnet examples may.
    function test_noMainnetRawKeyExamples() public view {
        string memory root = vm.projectRoot();
        string[5] memory paths = [
            string.concat(root, "/SURFACE.md"),
            string.concat(root, "/script/SeedPool.s.sol"),
            string.concat(root, "/script/DeploySidequest.s.sol"),
            string.concat(root, "/script/SafeAccept.s.sol"),
            string.concat(root, "/../docs/mainnet-runbook.md")
        ];
        for (uint256 i; i < paths.length; ++i) {
            _noMainnetRawKey(paths[i]);
        }
    }

    /// A line passing a raw key (`--private-key $…`, `"…"` or `…`) may not be, or follow, a mainnet or any-network line.
    function _noMainnetRawKey(string memory path) internal view {
        bytes memory text = bytes(vm.readFile(path));
        string memory prev = "";
        uint256 start;
        for (uint256 i; i <= text.length; ++i) {
            if (i < text.length && text[i] != "\n") continue;
            bytes memory raw = new bytes(i - start);
            for (uint256 j; j < raw.length; ++j) {
                raw[j] = text[start + j];
            }
            string memory line = string(raw);
            bool rawKey = vm.contains(line, "--private-key $") || vm.contains(line, "--private-key \"")
                || vm.contains(line, unicode"--private-key …");
            assertFalse(
                rawKey && (_anyNetwork(line) || _anyNetwork(prev)),
                string.concat(path, ": a mainnet raw-key command: ", line)
            );
            prev = line;
            start = i + 1;
        }
    }

    function _anyNetwork(string memory line) internal pure returns (bool) {
        return vm.contains(line, "monad-mainnet") || vm.contains(line, "MAINNET_GO") || vm.contains(line, "<network>");
    }

    function test_namedScriptsExist() public view {
        string memory root = vm.projectRoot();
        _has(string.concat(root, "/script/DeploySidequest.s.sol"), "function run()");
        _has(string.concat(root, "/script/PromoteSidequest.s.sol"), "function run()");
        _has(string.concat(root, "/script/SafeAccept.s.sol"), "function check()");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "process.argv.includes('--live')");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "Sidequest v1 production launch gate passed");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "process.argv.indexOf('--probe')");
        _has(string.concat(root, "/../package.json"), "\"deploy:prod\":");
    }

    function _has(string memory path, string memory needle) internal view {
        assertTrue(vm.contains(vm.readFile(path), needle), string.concat(path, " lacks ", needle));
    }

    /// Each needle must appear after the previous one.
    function _inOrder(string memory text, string[] memory needles, string memory what) internal pure {
        bytes memory rest = bytes(text);
        for (uint256 i; i < needles.length; ++i) {
            uint256 at = vm.indexOf(string(rest), needles[i]);
            assertTrue(at != type(uint256).max, string.concat(what, ": missing or out of order: ", needles[i]));
            rest = _tail(rest, at + bytes(needles[i]).length);
        }
    }

    function _tail(bytes memory b, uint256 start) internal pure returns (bytes memory out) {
        out = new bytes(b.length - start);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[start + i];
        }
    }
}
