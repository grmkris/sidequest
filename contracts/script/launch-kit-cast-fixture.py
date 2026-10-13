"""Strict, offline cast double used only by test_launch_kit.py; no network or keys."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
from decimal import Decimal

args = sys.argv[1:]
root = Path(os.environ['STUB_ROOT'])
network = os.environ['NETWORK']
config = json.loads((root / f'contracts/config/{network}.json').read_text())
addresses = json.loads((root / 'kit/addresses.json').read_text())
safe = config['sidequest']['safe']
state_file = root / 'chain-state.json'
state = json.loads(state_file.read_text()) if state_file.exists() else {'nonces': {}, 'transactions': {}, 'owners': {}}
with Path(os.environ['STUB_CALLS']).open('a') as out:
    out.write(json.dumps(args) + '\n')


def value(flag):
    return args[args.index(flag) + 1]


def persist():
    state_file.write_text(json.dumps(state))


def digest(text):
    return '0x' + hashlib.sha256(text.encode()).hexdigest()


def encode(record):
    return '0x' + json.dumps(record, separators=(',', ':')).encode().hex()


def decode(raw):
    return json.loads(bytes.fromhex(raw[2:]))


def signer():
    return addresses[Path(value('--keystore')).name.removeprefix('sidequest-')]


command = args[0]
if os.environ.get('STUB_FORBID_PLAN_READS') == '1' and command in ('call', 'estimate', 'calldata', 'mktx', 'wallet'):
    raise SystemExit('retry rebuilt the plan or re-signed')
if command == 'chain-id':
    calls = [json.loads(line) for line in Path(os.environ['STUB_CALLS']).read_text().splitlines()]
    read = sum(call[0] == 'chain-id' for call in calls)
    flip = int(os.environ.get('STUB_CHAIN_FLIP_AT', '0'))
    print(143 if flip and read >= flip else os.environ['STUB_CHAIN'])
elif command == 'keccak':
    print(digest(args[1]))
elif command == 'to-dec':
    print(int(args[1], 16) if args[1].startswith('0x') else args[1])
elif command == 'to-wei':
    print(int(Decimal(args[1]) * 10**18))
elif command == 'from-wei':
    print(Decimal(args[1]) / 10**18)
elif command == 'calldata':
    print(encode({'sig': args[1], 'args': args[2:]}))
elif command == 'wallet':
    if args[1] != 'address': raise SystemExit('keys forbidden in this test')
    print(os.environ.get('STUB_WRONG_SIGNER', signer()))
elif command == 'block':
    print(1800000000)
elif command == 'balance':
    print(100)
elif command == 'storage':
    print('0x0')
elif command == 'code':
    print('0x6000' if state['transactions'] else '0x')
elif command == 'nonce':
    if os.environ.get('STUB_NONCE_FAILURE') == '1': raise SystemExit('nonce read unavailable')
    print(state['nonces'].get(args[-1], 7))
elif command == 'estimate':
    print(100000)
elif command in ('mktx', 'send'):
    # send is supported only to demonstrate the old implementation's lost-response/double-payment regression.
    calls = [json.loads(line) for line in Path(os.environ['STUB_CALLS']).read_text().splitlines()]
    from_address = signer()
    nonce = int(value('--nonce')) if '--nonce' in args else state['nonces'].get(from_address, 7)
    raw = encode({'from': from_address, 'nonce': nonce, 'to': args[-2] if command == 'mktx' else safe,
                  'data': args[-1] if command == 'mktx' else '0x', 'serial': len(calls)})
    if command == 'mktx':
        print(raw)
    else:
        state['nonces'][from_address] = nonce + 1
        persist()
        raise SystemExit('old cast send answer lost')
elif command == 'publish':
    raw = args[-1]
    tx = decode(raw)
    hash_value = digest(raw)
    journals = list((root / 'kit').glob('*/operations/*/tx-*.json'))
    journal = next((json.loads(path.read_text()) for path in journals if json.loads(path.read_text())['hash'] == hash_value), None)
    if journal is None or journal['raw'] != raw or journal['nonce'] != str(tx['nonce']) or journal['from'] != tx['from']:
        raise SystemExit('published before signed transaction was journaled')
    plan = json.loads(Path(journal['operation']).read_text())
    if not plan['calls']: raise SystemExit('published before operation plan was saved')
    mode = os.environ.get('STUB_PUBLISH', 'success')
    if mode == 'crash-before-land':
        os.kill(os.getppid(), signal.SIGKILL)
        raise SystemExit(1)
    if mode != 'unknown-lost':
        tx.update(raw=raw, hash=hash_value, status='0x0' if mode == 'revert' else '0x1', pending=mode == 'pending-lost')
        state['transactions'][hash_value] = tx
    if mode not in ('pending-lost', 'unknown-lost'):
        state['nonces'][tx['from']] = tx['nonce'] + 1
        outer = decode(journal['call']['data'])
        if outer['sig'].startswith('execTransaction('):
            inner = decode(outer['args'][2])
            if inner['sig'] == 'acceptOwnership()': state['owners'][outer['args'][0]] = safe
    persist()
    if mode == 'crash-after-land':
        os.kill(os.getppid(), signal.SIGKILL)
        raise SystemExit(1)
    if mode.endswith('-lost'): raise SystemExit('publish answer lost')
    print(json.dumps({'transactionHash': hash_value, 'status': tx['status']}))
elif command == 'receipt':
    if os.environ.get('STUB_HIDE_RECEIPTS') == '1': raise SystemExit('receipt unavailable')
    if os.environ.get('STUB_RECEIPT_MISS_ONCE') == '1' and not state.get('missedReceipt'):
        state['missedReceipt'] = True
        persist()
        raise SystemExit('receipt unavailable at the previous block')
    tx = state['transactions'].get(args[-1])
    if tx is None or tx['pending']: raise SystemExit('transaction not found')
    print(json.dumps({'transactionHash': os.environ.get('STUB_WRONG_RECEIPT', tx['hash']), 'status': tx['status'], 'blockNumber': '0x123'}))
elif command == 'call':
    signature = next(arg for arg in args if '(' in arg)
    if signature.startswith('VERSION()'): print('"1.4.1"')
    elif signature.startswith('getOwners()'): print('[' + addresses['owner'] + ']')
    elif signature.startswith('getThreshold()'): print(1)
    elif signature.startswith('getModulesPaginated('): print('[]\n0x0000000000000000000000000000000000000001')
    elif signature.startswith('slashRecipient()'): print(safe)
    elif signature.startswith('pendingOwner()'): print(safe)
    elif signature.startswith('owner()'):
        target = args[args.index(signature) - 1]
        print(state['owners'].get(target, config['roles']['admin']))
    elif signature.startswith('minimumCreatorBond()'): print(config['sidequest']['minimumCreatorBond'])
    elif signature.startswith('MAX_MINIMUM_CREATOR_BOND()'): print(100000000000000000000000000)
    elif signature.startswith('decimals()'): print(18)
    elif signature.startswith('totalSupply()'): print(1000000000000000000000000000)
    elif signature.startswith('name()'): print('"Sidequest"')
    elif signature.startswith('getCreator('): print(safe)
    elif signature.startswith('createWithNative('):
        print(config['sidequest']['token'])
        print(1000000000000000000000000)
    elif signature.startswith('createProxyWithNonce('): print(safe)
    elif signature.startswith('balanceOf('): print(os.environ.get('STUB_BALANCE', '100000000000000000000000000'))
    elif signature.startswith(('getAmountOut(', 'getAmountIn(')): print(1000000000000000000)
    elif signature.startswith('deployFee('): print(100000000000000000)
    elif signature.startswith('stakeOf('): print(1000000000000000000000)
    elif signature.startswith(('execTransaction(', 'transfer(', 'buyWithNative(')): print('true')
    else: raise SystemExit('unexpected cast call: ' + signature)
else:
    raise SystemExit('unexpected cast command: ' + command)
