"""Offline launch-kit regressions: disposable kit/config and strict command doubles."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).parent


class LaunchKitTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for directory in ('contracts/script', 'contracts/config', 'bin', 'kit'):
            (self.root / directory).mkdir(parents=True)
        shutil.copyfile(SCRIPT / 'launch-kit.sh', self.root / 'contracts/script/launch-kit.sh')
        for network in ('monad-mainnet', 'monad-testnet'):
            shutil.copyfile(SCRIPT.parent / f'config/{network}.json', self.root / f'contracts/config/{network}.json')
        self.calls = self.root / 'calls.jsonl'
        self.stub('cast', '''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['STUB_CALLS']).open('a') as out:
    out.write(json.dumps(args) + '\\n')
if args[0] == 'chain-id':
    print(os.environ['STUB_CHAIN'])
else:
    raise SystemExit('unexpected cast command')
''')

    def stub(self, name, source):
        executable = self.root / 'bin' / name
        executable.write_text('#!/usr/bin/env python3\n' + source)
        executable.chmod(0o700)

    def run_kit(self, network, chain, *args, go=''):
        env = dict(os.environ, PATH=str(self.root / 'bin') + ':' + os.environ['PATH'],
                   KIT_HOME=str(self.root / 'kit'), NETWORK=network, MAINNET_GO=go,
                   STUB_CHAIN=str(chain), STUB_CALLS=str(self.calls))
        return subprocess.run(['bash', str(self.root / 'contracts/script/launch-kit.sh'), *args],
                              env=env, capture_output=True, text=True)

    def recorded_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def assert_wrong_chain(self, network, actual, expected):
        for command in ('safe', 'token', 'move', 'accept', 'backing', 'exit', 'bond', 'fund'):
            for mode in ('plan', 'send'):
                with self.subTest(command=command, mode=mode):
                    self.calls.write_text('')
                    args = (command, 'buy', mode, '1') if command == 'exit' else (command, mode)
                    result = self.run_kit(network, actual, *args, go='yes')
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f'RPC chain {actual} does not match config chain {expected}', result.stderr)
                    self.assertEqual(self.recorded_calls(), [['chain-id', '--rpc-url', json.loads(
                        (self.root / f'contracts/config/{network}.json').read_text())['launchKit']['rpc']]])

    def test_testnet_config_refuses_mainnet_rpc_before_plan_or_send(self):
        self.assert_wrong_chain('monad-testnet', 143, 10143)

    def test_mainnet_config_refuses_testnet_rpc_before_plan_or_send(self):
        self.assert_wrong_chain('monad-mainnet', 10143, 143)


if __name__ == '__main__':
    unittest.main()
