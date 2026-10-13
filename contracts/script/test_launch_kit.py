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
        shutil.copyfile(os.environ.get('LAUNCH_KIT_TEST_SOURCE', SCRIPT / 'launch-kit.sh'), self.root / 'contracts/script/launch-kit.sh')
        shutil.copyfile(SCRIPT / 'launch-kit-journal.sh', self.root / 'contracts/script/launch-kit-journal.sh')
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

    def run_kit(self, network, chain, *args, go='', **settings):
        env = dict(os.environ, PATH=str(self.root / 'bin') + ':' + os.environ['PATH'],
                   KIT_HOME=str(self.root / 'kit'), NETWORK=network, MAINNET_GO=go,
                   STUB_CHAIN=str(chain), STUB_CALLS=str(self.calls), STUB_ROOT=str(self.root))
        env.update(settings)
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

    def acceptance_fixture(self):
        record = json.loads((self.root / 'contracts/config/monad-testnet.json').read_text())
        safe = record['sidequest']['safe']
        owner = '0x0000000000000000000000000000000000000011'
        (self.root / 'kit/addresses.json').write_text(json.dumps({'owner': owner, 'testnetOnly': False}))
        self.stub('cast', f'''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['STUB_CALLS']).open('a') as out:
    out.write(json.dumps(args) + '\\n')
if args[0] == 'chain-id': print(os.environ['STUB_CHAIN'])
elif any('VERSION()' in arg for arg in args): print('"1.4.1"')
elif any('getOwners()' in arg for arg in args): print('[{owner}]')
elif any('slashRecipient()' in arg for arg in args): print('{safe}')
else: raise SystemExit('unexpected cast command')
''')
        mainnet = json.loads((self.root / 'contracts/config/monad-mainnet.json').read_text())
        mainnet['sidequest'] = record['sidequest']
        mainnet['deployment'] = record['deployment']
        mainnet['deployment']['sidequest']['slashRecipient'] = safe
        (self.root / 'contracts/config/monad-mainnet.json').write_text(json.dumps(mainnet))
        self.forge_calls = self.root / 'forge.jsonl'
        self.stub('forge', f'''import json, sys
from pathlib import Path
args = sys.argv[1:]
with Path({str(self.forge_calls)!r}).open('a') as out:
    out.write(json.dumps(args) + '\\n')
if '--sig' not in args or args[args.index('--sig') + 1] != 'simulate()':
    raise SystemExit('the plan must select the non-broadcast simulation')
if '--broadcast' in args: raise SystemExit('simulation broadcast forbidden')
''')

    def test_accept_plan_selects_simulation_without_mainnet_go(self):
        self.acceptance_fixture()
        result = self.run_kit('monad-mainnet', 143, 'accept', 'plan')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.forge_calls.read_text().splitlines()), 1)

    def test_accept_send_still_refuses_without_mainnet_go(self):
        self.acceptance_fixture()
        result = self.run_kit('monad-mainnet', 143, 'accept', 'send')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('a mainnet send needs MAINNET_GO=yes', result.stderr)
        self.assertFalse(self.forge_calls.exists())

    def journal_fixture(self):
        self.stub('cast', (SCRIPT / 'launch-kit-cast-fixture.py').read_text())
        (self.root / 'chain-state.json').write_text(json.dumps({'nonces': {}, 'transactions': {}, 'owners': {}}))
        record = json.loads((self.root / 'contracts/config/monad-testnet.json').read_text())
        record['sidequest']['safe'] = '0x00000000000000000000000000000000000000aa'
        record['sidequest']['token'] = '0x00000000000000000000000000000000000000bb'
        record['deployment']['sidequest']['safe'] = record['sidequest']['safe']
        record['deployment']['sidequest']['factory'] = record['sidequest']['token']
        record['deployment']['sidequest']['slashRecipient'] = record['sidequest']['safe']
        record['sidequest']['slashRecipient'] = record['sidequest']['safe']
        (self.root / 'contracts/config/monad-testnet.json').write_text(json.dumps(record))
        (self.root / 'kit/addresses.json').write_text(json.dumps({
            'owner': '0x0000000000000000000000000000000000000011',
            'creator': '0x0000000000000000000000000000000000000022',
            'exit-test': '0x0000000000000000000000000000000000000033',
            'testnetOnly': False,
        }))
        for name in ('owner', 'creator', 'exit-test'):
            secret = self.root / f'kit/secrets/sidequest-{name}.password'
            secret.parent.mkdir(exist_ok=True)
            secret.write_text('unit-test-password')
        self.stub('forge', '''import sys
if '--broadcast' in sys.argv: raise SystemExit('broadcast forbidden; kit acceptance must be journaled')
''')
        self.stub('curl', 'pass\n')

    def journal_path(self):
        return next((self.root / 'kit/monad-testnet/operations').glob('*/plan.json')).parent

    def run_send(self, *args, **settings):
        return self.run_kit('monad-testnet', 10143, *args, **settings)

    def payment(self):
        return ('fund', 'send', '0x00000000000000000000000000000000000000cc', '1')

    def backing(self):
        self.backing_file = self.root / 'backing.json'
        self.backing_file.write_text(json.dumps([{'account': '0x00000000000000000000000000000000000000cc', 'side': '1'}]))
        return ('backing', 'send', str(self.backing_file))

    def test_pending_payment_republishes_exact_bytes_without_a_new_safe_nonce(self):
        self.journal_fixture()
        command = self.payment()
        first = self.run_send(*command, STUB_PUBLISH='pending-lost')
        self.assertNotEqual(first.returncode, 0, first.stdout)
        signed = (self.journal_path() / 'tx-0.json').read_text()
        second = self.run_send(*command, STUB_FORBID_PLAN_READS='1')
        self.assertEqual(second.returncode, 0, second.stderr)
        calls = self.recorded_calls()
        published = [call[-1] for call in calls if call[0] == 'publish']
        self.assertEqual(len(published), 2)
        self.assertEqual(published[0], published[1])
        self.assertEqual(sum(call[0] == 'mktx' for call in calls), 1)
        self.assertEqual(json.loads(signed)['raw'], published[0])

    def test_lost_backing_answer_adopts_original_landed_batch(self):
        self.journal_fixture()
        command = self.backing()
        first = self.run_send(*command, STUB_PUBLISH='mined-lost', STUB_HIDE_RECEIPTS='1')
        self.assertNotEqual(first.returncode, 0, first.stdout)
        plan = (self.journal_path() / 'plan.json').read_text()
        second = self.run_send(*command, STUB_FORBID_PLAN_READS='1')
        self.assertEqual(second.returncode, 0, second.stderr)
        calls = self.recorded_calls()
        self.assertEqual(sum(call[0] == 'mktx' for call in calls), 1)
        self.assertEqual(sum(call[0] == 'publish' for call in calls), 1)
        self.assertEqual((self.journal_path() / 'plan.json').read_text(), plan)
        self.assertEqual(json.loads(plan)['request']['backing'], json.loads(self.backing_file.read_text()))

    def test_completed_payment_rerun_has_no_second_payment(self):
        self.journal_fixture()
        command = self.payment()
        first = self.run_send(*command)
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.run_send(*command, STUB_FORBID_PLAN_READS='1')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 1)

    def test_every_economic_command_resumes_before_rebuilding_its_plan(self):
        self.journal_fixture()
        for command in (('safe', 'send'), ('move', 'send'), ('bond', 'send', '1'),
                        ('exit', 'buy', 'send', '1'), ('exit', 'sell', 'send', 'all'), ('accept', 'send')):
            with self.subTest(command=command):
                first = self.run_send(*command, STUB_PUBLISH='crash-after-land')
                self.assertNotEqual(first.returncode, 0)
                plans = list((self.root / 'kit/monad-testnet/operations').glob('*/plan.json'))
                matching = next(path for path in plans if json.loads(path.read_text())['request']['arguments'] == list(command))
                plan = matching.read_text()
                # Single-action retry must perform no plan reads/signing. Multi-step sends sign only remaining steps.
                settings = {} if command[0] == 'accept' or command[:2] == ('exit', 'sell') else {'STUB_FORBID_PLAN_READS': '1'}
                second = self.run_send(*command, **settings)
                self.assertEqual(second.returncode, 0, second.stderr)
                self.assertEqual(matching.read_text(), plan)
                self.assertTrue((matching.parent / 'complete.json').exists())

    def test_multistep_exit_freezes_both_calls_before_first_broadcast(self):
        self.journal_fixture()
        command = ('exit', 'sell', 'send', 'all')
        first = self.run_send(*command, STUB_PUBLISH='crash-after-land')
        self.assertNotEqual(first.returncode, 0)
        plan = json.loads((self.journal_path() / 'plan.json').read_text())
        self.assertEqual(len(plan['calls']), 2)
        second = self.run_send(*command, STUB_BALANCE='0')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 2)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 2)
        self.assertEqual(json.loads((self.journal_path() / 'plan.json').read_text()), plan)

    def test_reverted_original_stops_and_never_resigns(self):
        self.journal_fixture()
        command = self.payment()
        first = self.run_send(*command, STUB_PUBLISH='revert')
        self.assertNotEqual(first.returncode, 0)
        self.assertIn('reverted', first.stderr)
        second = self.run_send(*command, STUB_FORBID_PLAN_READS='1')
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('reverted', second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)

    def test_reverted_original_allows_a_deliberate_new_operation(self):
        self.journal_fixture()
        command = self.payment()
        self.assertNotEqual(self.run_send(*command, STUB_PUBLISH='revert').returncode, 0)
        self.assertTrue((self.journal_path() / 'failed.json').exists())
        result = self.run_send(*command, KIT_OPERATION='new-payment-after-verified-revert')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 2)

    def test_changed_backing_plan_refuses_without_signing(self):
        self.journal_fixture()
        command = self.backing()
        first = self.run_send(*command, STUB_PUBLISH='pending-lost')
        self.assertNotEqual(first.returncode, 0)
        self.backing_file.write_text(json.dumps([{'account': '0x00000000000000000000000000000000000000cc', 'side': '2'}]))
        second = self.run_send(*command)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('saved operation differs', second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)

    def test_unfinished_operation_blocks_a_new_operation_id(self):
        self.journal_fixture()
        command = self.payment()
        first = self.run_send(*command, STUB_PUBLISH='pending-lost')
        self.assertNotEqual(first.returncode, 0)
        second = self.run_send(*command, KIT_OPERATION='deliberate-second-payment')
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('unfinished operation', second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)

    def test_new_id_after_completion_allows_an_intentional_second_payment(self):
        self.journal_fixture()
        command = self.payment()
        first = self.run_send(*command)
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.run_send(*command, KIT_OPERATION='deliberate-second-payment')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 2)

    def test_journal_is_private_and_contains_complete_signed_operation(self):
        self.journal_fixture()
        result = self.run_send(*self.payment())
        self.assertEqual(result.returncode, 0, result.stderr)
        path = self.journal_path()
        saved = json.loads((path / 'tx-0.json').read_text())
        self.assertEqual(saved['operation'], str(path / 'plan.json'))
        self.assertEqual(saved['nonce'], '7')
        self.assertIn('raw', saved)
        self.assertIn('hash', saved)
        self.assertIn('receipt', saved)
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual((path / 'tx-0.json').stat().st_mode & 0o777, 0o600)
        self.assertNotIn(saved['raw'], result.stdout + result.stderr)

    def test_pending_backing_retry_keeps_the_original_safe_batch(self):
        self.journal_fixture()
        command = self.backing()
        self.assertNotEqual(self.run_send(*command, STUB_PUBLISH='pending-lost').returncode, 0)
        second = self.run_send(*command, STUB_FORBID_PLAN_READS='1')
        self.assertEqual(second.returncode, 0, second.stderr)
        published = [call[-1] for call in self.recorded_calls() if call[0] == 'publish']
        self.assertEqual(len(published), 2)
        self.assertEqual(published[0], published[1])
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)

    def test_missing_nonce_read_stops_with_original_signed_bytes(self):
        self.journal_fixture()
        command = self.payment()
        self.assertNotEqual(self.run_send(*command, STUB_PUBLISH='pending-lost').returncode, 0)
        second = self.run_send(*command, STUB_NONCE_FAILURE='1')
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('cannot reconcile sender nonce', second.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 1)

    def test_corrupted_signed_bytes_are_never_republished(self):
        self.journal_fixture()
        command = self.payment()
        self.assertNotEqual(self.run_send(*command, STUB_PUBLISH='pending-lost').returncode, 0)
        path = self.journal_path() / 'tx-0.json'
        saved = json.loads(path.read_text())
        saved['raw'] += '00'
        path.write_text(json.dumps(saved))
        second = self.run_send(*command)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('saved signed bytes do not match', second.stderr)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 1)

    def test_chain_change_after_signing_refuses_publish(self):
        self.journal_fixture()
        result = self.run_send(*self.payment(), STUB_CHAIN_FLIP_AT='5')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('RPC chain 143 does not match config chain 10143', result.stderr)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 0)
        self.assertTrue((self.journal_path() / 'tx-0.json').exists())

    def test_wrong_keystore_sender_refuses_before_signing(self):
        self.journal_fixture()
        result = self.run_send(*self.payment(), STUB_WRONG_SIGNER='0x0000000000000000000000000000000000000000')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('keystore does not match the planned sender', result.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 0)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 0)

    def test_failed_journal_write_refuses_before_signing_or_publish(self):
        self.journal_fixture()
        self.stub('mv', 'raise SystemExit("fixture disk write failed")\n')
        result = self.run_send(*self.payment())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot persist journal', result.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 0)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 0)

    def test_mismatched_receipt_is_never_adopted(self):
        self.journal_fixture()
        result = self.run_send(*self.payment(), STUB_WRONG_RECEIPT='0x' + 'ff' * 32)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('receipt does not match journaled transaction', result.stderr)
        self.assertFalse((self.journal_path() / 'complete.json').exists())

    def test_receipt_nonce_race_rechecks_and_adopts_original_receipt(self):
        self.journal_fixture()
        command = self.payment()
        self.assertNotEqual(self.run_send(*command, STUB_PUBLISH='crash-after-land').returncode, 0)
        result = self.run_send(*command, STUB_RECEIPT_MISS_ONCE='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)
        self.assertEqual(sum(call[0] == 'publish' for call in self.recorded_calls()), 1)

    def test_token_retry_adopts_original_deployment_and_restores_discovery(self):
        self.journal_fixture()
        path = self.root / 'kit/monad-testnet/token-plan.json'
        path.parent.mkdir(parents=True)
        record = json.loads((self.root / 'contracts/config/monad-testnet.json').read_text())
        path.write_text(json.dumps({'predicted': record['sidequest']['token'], 'creator':
            '0x0000000000000000000000000000000000000022', 'safe': record['sidequest']['safe'],
            'name': 'Sidequest', 'symbol': 'SIDE', 'metadataUri': 'https://unused.invalid/token',
            'salt': '0x' + '00' * 32, 'buy': '1', 'margin': '1'}))
        first = self.run_send('token', 'send', STUB_PUBLISH='crash-after-land')
        self.assertNotEqual(first.returncode, 0)
        result = self.run_send('token', 'send', STUB_FORBID_PLAN_READS='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(call[0] == 'mktx' for call in self.recorded_calls()), 1)
        discovered = json.loads((path.parent / 'token.json').read_text())
        self.assertEqual(discovered['token'], record['sidequest']['token'])

    def test_unknown_publish_answer_reuses_signed_bytes_and_nonce(self):
        self.journal_fixture()
        first = self.run_kit('monad-testnet', 10143, 'move', 'send', '1', STUB_PUBLISH='crash-before-land')
        self.assertNotEqual(first.returncode, 0)
        second = self.run_kit('monad-testnet', 10143, 'move', 'send', '1', STUB_FORBID_PLAN_READS='1')
        self.assertEqual(second.returncode, 0, second.stderr)
        calls = self.recorded_calls()
        self.assertEqual(sum(call[0] == 'mktx' for call in calls), 1)
        published = [call[-1] for call in calls if call[0] == 'publish']
        self.assertEqual(len(published), 2)
        self.assertEqual(published[0], published[1], 'retry published different signed bytes')
        self.assertFalse(any(call[0] == 'send' for call in calls))

    def test_landed_transaction_is_adopted_without_republish(self):
        self.journal_fixture()
        first = self.run_kit('monad-testnet', 10143, 'move', 'send', '1', STUB_PUBLISH='crash-after-land')
        self.assertNotEqual(first.returncode, 0)
        second = self.run_kit('monad-testnet', 10143, 'move', 'send', '1', STUB_FORBID_PLAN_READS='1')
        self.assertEqual(second.returncode, 0, second.stderr)
        calls = self.recorded_calls()
        self.assertEqual(sum(call[0] == 'mktx' for call in calls), 1)
        self.assertEqual(sum(call[0] == 'publish' for call in calls), 1)

    def test_spent_nonce_stops_without_re_signing(self):
        self.journal_fixture()
        first = self.run_kit('monad-testnet', 10143, 'move', 'send', '1', STUB_PUBLISH='crash-before-land')
        self.assertNotEqual(first.returncode, 0)
        state = json.loads((self.root / 'chain-state.json').read_text())
        state['nonces']['0x0000000000000000000000000000000000000022'] = 8
        (self.root / 'chain-state.json').write_text(json.dumps(state))
        second = self.run_kit('monad-testnet', 10143, 'move', 'send', '1', STUB_FORBID_PLAN_READS='1')
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('is spent but', second.stderr)
        calls = self.recorded_calls()
        self.assertEqual(sum(call[0] == 'mktx' for call in calls), 1)
        self.assertEqual(sum(call[0] == 'publish' for call in calls), 1)


if __name__ == '__main__':
    unittest.main()
