// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice The G1-DRY-001 residual, source-level: the fork rehearsals take the launch lock
///         (`script/launch-lock.sh`) before anything else, no anvil they start can hold it past their run, and the
///         rehearsals keep forge to their own `broadcast/` and `cache/rehearsal-<id>` directories. What it does at run
///         time is `script/test-launch-lock.sh` (a second concurrent invocation refuses) and the rehearsals themselves.
contract LaunchLockTest is Test {
    string internal constant TAKE = "cd \"$(dirname \"$0\")/..\"\n. script/launch-lock.sh\ntake_launch_lock\n";

    function _scripts() internal pure returns (string[] memory s) {
        s = new string[](2);
        s[0] = "rehearse-launch.sh";
        s[1] = "rehearse-sidequest-pipeline.sh";
    }

    function _read(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/script/", name));
    }

    function test_everyRunTakesTheLockFirst() public view {
        string[] memory s = _scripts();
        for (uint256 i; i < s.length; i++) {
            string memory src = _read(s[i]);
            assertTrue(vm.contains(src, TAKE), string.concat(s[i], ": no take_launch_lock right after cd"));
            // Nothing runs before it: the cd is the script's first command.
            string[] memory lines = vm.split(src, "\n");
            for (uint256 j; j < lines.length; j++) {
                string memory l = vm.trim(lines[j]);
                if (bytes(l).length == 0 || bytes(l)[0] == "#" || _eq(l, "set -euo pipefail") || _startsWith(l, "{ #"))
                {
                    continue;
                }
                assertEq(
                    l, "cd \"$(dirname \"$0\")/..\"", string.concat(s[i], ": a command before the cd and the lock")
                );
                break;
            }
        }
    }

    function test_noAnvilHoldsTheLock() public view {
        string[] memory s = _scripts();
        uint256 anvils;
        for (uint256 i; i < s.length; i++) {
            string[] memory lines = vm.split(_read(s[i]), "\n");
            for (uint256 j; j < lines.length; j++) {
                if (!_startsWith(vm.trim(lines[j]), "anvil --fork-url")) continue;
                anvils++;
                assertTrue(
                    vm.contains(lines[j], "9>&-"), string.concat(s[i], ": an anvil started with the lock's fd 9")
                );
            }
        }
        assertEq(anvils, 2, "one forked anvil per rehearsal");
    }

    function test_rehearsalsUseTheirOwnForgePaths() public view {
        string[] memory s = _scripts();
        for (uint256 i = 1; i < s.length; i++) {
            string memory src = _read(s[i]);
            assertTrue(vm.contains(src, "\nrehearsal_run\n"), string.concat(s[i], ": no rehearsal_run"));
            assertTrue(vm.contains(src, "owned_run_dirs"), string.concat(s[i], ": cleanup without owned_run_dirs"));
            assertTrue(
                vm.contains(src, "REAL_LOGS=$(real_logs \"$CHAIN\")"), string.concat(s[i], ": no real_logs check")
            );
            string[] memory lines = vm.split(src, "\n");
            for (uint256 j; j < lines.length; j++) {
                string memory l = vm.trim(lines[j]);
                if (bytes(l).length > 0 && bytes(l)[0] == "#") continue;
                assertFalse(
                    vm.contains(l, "\"broadcast/") || vm.contains(l, " broadcast/") || vm.contains(l, "\"cache/"),
                    string.concat(s[i], ": a default forge path outside its own directories: ", l)
                );
            }
        }
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _startsWith(string memory a, string memory p) internal pure returns (bool) {
        bytes memory x = bytes(a);
        bytes memory y = bytes(p);
        if (x.length < y.length) return false;
        for (uint256 i; i < y.length; i++) {
            if (x[i] != y[i]) return false;
        }
        return true;
    }
}
