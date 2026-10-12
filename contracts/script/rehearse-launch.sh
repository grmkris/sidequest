#!/usr/bin/env bash
# R7: the mainnet launch, end to end, on a throwaway anvil fork of Monad mainnet (chain 143), Monad gas pricing.
# Steps, in launch order (docs/mainnet-runbook.md, D16):
#   1. a 1-of-1 Safe (the launch shape, note 22 on 12 Oct) from the canonical v1.4.1 SafeProxyFactory + SafeL2
#      singleton (their code is checked first);
#   2. SIDE created through the real nad.fun router (Kris's wallet at launch; a dev key here) with the 5% dev buy in the
#      creation transaction and the creator-fee vault paying the Safe; no burn; transfers to the slash recipient work; the dev buy
#      goes to the Safe, keeping what funds the rehearsal's hires;
#   3. DeploySidequest with a fresh core and MAINNET_GO, against that SIDE; PromoteSidequest (no transactions), then the
#      D16 launch gate, which must refuse: the four are only pending;
#   4. SafeAccept (four execTransactions from an owner), then the D16 gate, which must pass with this Safe's owners and
#      threshold pinned (LAUNCH-AUDIT-003), and refuse a wrong owner pin and a guard;
#   5. the 2-of-3 due by 20 Oct, in place: two addOwnerWithThreshold calls through execTransaction from the owner; the
#      gate refuses the 1-of-1 pin and passes the 2-of-3 one (after launch day, so outside the launch budget);
#   6. two hires paid in SIDE: one delivered, accepted and settled; one never delivered, slashed after its deadline, the
#      worker bond landing in the vault's slash recipient (the Safe);
#   7. a small buy and sell of SIDE through the router;
#   8. the creator-fee vault names the Safe as SIDE's recipient.
# Every step's gas (the limits actually sent, which Monad charges, and gasUsed) is printed as the launch budget.
# Sends nothing to a real chain: anvil's public dev keys sign everything, against a local fork. Holds the launch lock
# (script/launch-lock.sh), so it refuses while another launch or rehearsal runs in this checkout. Writes only its own
# scratch config/rehearsal-<pid>-<random>.json and forge logs under broadcast/ and cache/rehearsal-<pid>-<random>
# (script/rehearse-owned.sh), never a real launch's chain-143 run-latest.json, and removes them on exit. Needs anvil,
# forge, cast, jq, bun.
#   RPC=https://rpc.monad.xyz bash script/rehearse-launch.sh
set -euo pipefail
{ # parsed whole before it runs, so an edit to this file mid-run cannot change what runs
cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
. script/rehearse-owned.sh

FORK_RPC="${RPC:-https://rpc.monad.xyz}"
PORT="${PORT:-8598}"
LOCAL="http://127.0.0.1:$PORT"
CHAIN=143
BUDGET="$(mktemp)"
GATE_TS="$(mktemp --suffix=.ts)"
REPO="$(cd .. && pwd)"

# nad.fun V2 on chain 143, from the config's `nadfun` block: the router, the wrapped-MON quote token and the creator-fee
# vault, whose setupData `abi.encode(recipient)` names who claims the 1% creator fee.
NADFUN_ROUTER=$(jq -r .nadfun.router config/monad-mainnet.json)
WMON=$(jq -r .nadfun.wmon config/monad-mainnet.json)
CREATOR_FEE_VAULT=$(jq -r .nadfun.creatorFeeVault config/monad-mainnet.json)

# Canonical Safe v1.4.1 on chain 143.
SAFE_SIDE=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
FALLBACK_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ZERO=0x0000000000000000000000000000000000000000

# anvil's public development keys, derived from its well-known mnemonic; never real funds.
MNEMONIC="test test test test test test test test test test test junk"
devkey() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
K_DEPLOYER=$(devkey 0); K_OWNER1=$(devkey 1); K_OWNER2=$(devkey 2); K_ARBITRATOR=$(devkey 3); K_RELAY=$(devkey 4)
K_ATTESTER=$(devkey 5); K_CREATOR=$(devkey 6); K_WORKER=$(devkey 7); K_TEAM=$(devkey 8)
K_KRIS=$(devkey 9); K_OWNER3=$(devkey 10)
addr() { cast wallet address --private-key "$1"; }

ANVIL_PID= SAFE= CONFIG=
# Only what this run created, and still owns.
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  owned_file "$CONFIG" .sidequest.safe "$SAFE"
  owned_run_dirs
  rm -f "$GATE_TS" "$BUDGET"
}
trap cleanup EXIT
rehearsal_run
REAL_LOGS=$(real_logs "$CHAIN")
CONFIG="config/$NETWORK.json"
[[ ! -e "$CONFIG" ]] || { echo "refusing: $CONFIG exists" >&2; exit 1; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
log() { local f=$1; shift; "$@" >"$f" 2>&1 || { tail -30 "$f"; return 1; }; }

# Gas of one broadcast run, from the node: the limit each transaction was sent with (charged on Monad) and gasUsed.
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$BUDGET"; }
budget_hashes() {
  local label=$1 tl=0 tu=0 n=0 h
  shift
  for h in "$@"; do
    case "$(cast receipt --rpc-url "$LOCAL" "$h" status)" in true | 1 | "1 (success)") ;; *) fail "$label: a failed receipt" ;; esac
    tl=$((tl + $(cast tx --rpc-url "$LOCAL" "$h" gas)))
    tu=$((tu + $(cast receipt --rpc-url "$LOCAL" "$h" gasUsed)))
    n=$((n + 1))
  done
  record "$label" "$n" "$tl" "$tu"
}
budget_run() { mapfile -t hashes < <(jq -r '.receipts[].transactionHash' "$FOUNDRY_BROADCAST/$2.s.sol/$CHAIN/run-latest.json"); budget_hashes "$1" "${hashes[@]}"; }

# D16 launch gate (apps/api/src/prod-config.ts) against the fork, with the scratch config and the shared
# RELAY_FLOOR_MAINNET (packages/sdk/src/relay.ts). Prints the failure labels; exit 3 when it refuses. Run with bun, as the
# prod preflight is (the SDK uses TypeScript that node's strip-only mode refuses).
cat >"$GATE_TS" <<EOF
import { readFileSync } from 'node:fs'
import { RELAY_FLOOR_MAINNET } from '$REPO/packages/sdk/src/relay.ts'
import { liveLaunchGate } from '$REPO/apps/api/src/prod-config.ts'
import { rpcReader } from '$REPO/apps/api/src/deploy-preflight.ts'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
// argv[4]: the Safe policy the artifact would pin (deployment.sidequest.safeOwners / safeThreshold), as JSON.
const failures = await liveLaunchGate(config, rpcReader(process.argv[3]), RELAY_FLOOR_MAINNET, JSON.parse(process.argv[4]))
console.log(JSON.stringify(failures))
process.exit(failures.length > 0 ? 3 : 0)
EOF
gate() { bun "$GATE_TS" "$CONFIG" "$LOCAL" "${1:-$POLICY}"; }

# The fork must be this run's own anvil: refuse a port something else already serves.
cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && fail "port $PORT already serves an RPC; stop it, or set PORT"
anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent 9>&- &
ANVIL_PID=$!
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL")" == "$CHAIN" ]] || fail "anvil fork of chain 143 not up"
kill -0 "$ANVIL_PID" 2>/dev/null || fail "the anvil this run started is not running (port $PORT taken?)"

DEPLOYER=$(addr $K_DEPLOYER); OWNER1=$(addr $K_OWNER1); OWNER2=$(addr $K_OWNER2); OWNER3=$(addr $K_OWNER3); KRIS=$(addr $K_KRIS)
# The Safe policy an artifact would pin for this Safe (deployment.sidequest.safeOwners / safeThreshold), which D16 reads back.
POLICY="{\"owners\":[\"$OWNER1\"],\"threshold\":1}"
ARBITRATOR=$(addr $K_ARBITRATOR); RELAY=$(addr $K_RELAY); ATTESTER=$(addr $K_ATTESTER); TEAM=$(addr $K_TEAM)
for k in $K_DEPLOYER $K_OWNER1 $K_OWNER2 $K_RELAY $K_CREATOR $K_WORKER $K_KRIS; do
  cast rpc --rpc-url "$LOCAL" anvil_setBalance "$(addr "$k")" 0x21e19e0c9bab2400000 >/dev/null # 10,000 MON
done
# The dev keys are public, and on Monad (mainnet and testnet) each carries someone's EIP-7702 delegation; the fork
# inherits it. Clear it, so they behave as the plain EOAs the real launch signs from.
for k in $K_DEPLOYER $K_OWNER1 $K_OWNER2 $K_OWNER3 $K_ARBITRATOR $K_RELAY $K_ATTESTER $K_CREATOR $K_WORKER $K_TEAM $K_KRIS; do
  cast rpc --rpc-url "$LOCAL" anvil_setCode "$(addr "$k")" 0x >/dev/null
done

# 1. The Safe.
for c in $SAFE_SIDE $SAFE_L2 $FALLBACK_HANDLER; do
  [[ "$(cast code --rpc-url "$LOCAL" $c)" != "0x" ]] || fail "no code at canonical Safe contract $c on chain 143"
done
SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNER1]" 1 $ZERO 0x $FALLBACK_HANDLER $ZERO 0 $ZERO)
SALT=$(date +%s)
SAFE=$(cast call --rpc-url "$LOCAL" --from "$DEPLOYER" $SAFE_SIDE "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_L2 "$SETUP" "$SALT")
TX=$(cast send --rpc-url "$LOCAL" --private-key $K_DEPLOYER --json $SAFE_SIDE "createProxyWithNonce(address,bytes,uint256)" $SAFE_L2 "$SETUP" "$SALT" | jq -r .transactionHash)
budget_hashes "1. Safe (1-of-1, SafeProxyFactory)" "$TX"
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "getThreshold()(uint256)")" == "1" ]] || fail "Safe threshold"
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "VERSION()(string)")" == '"1.4.1"' ]] || fail "Safe version"
ok "Safe $SAFE (1.4.1, owner $OWNER1, threshold 1)"

# 2. SIDE on nad.fun: created through the router with the 5% dev buy bundled into the creation transaction, the
# creator fee paid to the Safe. 3,600 MON buys about 5% of the curve at launch; the check below holds it to 4.5–5.5%.
[[ "$(cast code --rpc-url "$LOCAL" $NADFUN_ROUTER)" != "0x" ]] || fail "no nad.fun router at $NADFUN_ROUTER on chain 143"
NOW=$(cast block --rpc-url "$LOCAL" latest -f timestamp)
CREATE="createWithNative((string,string,string,address,uint16,(address,uint16,bytes)[],bytes32,uint8,uint256,uint256))"
PARAMS="(Sidequest,SIDE,https://sidequest.exchange/token.json,$WMON,100,[($CREATOR_FEE_VAULT,10000,$(cast abi-encode 'f(address)' "$SAFE"))],$(cast keccak "r7-$SALT"),0,$(cast to-wei 3600),$((NOW + 600)))"
TX=$(cast send --rpc-url "$LOCAL" --private-key $K_KRIS --json --value "$(cast to-wei 3700)" $NADFUN_ROUTER "$CREATE" "$PARAMS" \
  | jq -r .transactionHash) || fail "nad.fun createWithNative"
budget_hashes "2. SIDE on nad.fun (create + 5% dev buy, Kris's wallet)" "$TX"
TOPIC=$(cast keccak "Create(address,address)")
SIDE=$(cast receipt --rpc-url "$LOCAL" "$TX" --json | jq -r --arg r "$(tr 'A-F' 'a-f' <<<"$NADFUN_ROUTER")" --arg t "$TOPIC" \
  '.logs[] | select((.address | ascii_downcase) == $r and .topics[0] == $t) | .topics[1]' | head -1)
[[ -n "$SIDE" && "$SIDE" != null ]] || fail "no Create event from the router"
SIDE=$(cast parse-bytes32-address "$SIDE")
[[ "$(cast call --rpc-url "$LOCAL" "$SIDE" "totalSupply()(uint256)" | awk '{print $1}')" == 1000000000000000000000000000 ]] \
  || fail "SIDE supply is not 1e9"
[[ "$(cast call --rpc-url "$LOCAL" "$SIDE" "decimals()(uint8)")" == 18 ]] || fail "SIDE decimals"
cast call --rpc-url "$LOCAL" "$SIDE" "nonces(address)(uint256)" "$KRIS" >/dev/null || fail "SIDE has no permit nonces"
cast call --rpc-url "$LOCAL" --from "$KRIS" "$SIDE" "burn(uint256)" 1 >/dev/null 2>&1 && fail "SIDE unexpectedly has a burn"
BOUGHT=$(cast call --rpc-url "$LOCAL" "$SIDE" "balanceOf(address)(uint256)" "$KRIS" | awk '{print $1}')
python3 -c "import sys; b=int(sys.argv[1]); sys.exit(0 if 45_000_000*10**18 <= b <= 55_000_000*10**18 else 1)" "$BOUGHT" \
  || fail "the dev buy got $BOUGHT SIDE wei, not about 5% of the supply"
cast send --rpc-url "$LOCAL" --private-key $K_KRIS "$SIDE" "transfer(address,uint256)" "$SAFE" 1 >/dev/null \
  || fail "a transfer to the slash recipient reverts before graduation"
# The Safe gets the dev buy; Kris's wallet keeps 10M here to fund the rehearsal's hires (at launch the Safe does).
TO_SAFE=$(python3 -c "import sys; print(int(sys.argv[1]) - 1 - 10_000_000 * 10**18)" "$BOUGHT")
TX2=$(cast send --rpc-url "$LOCAL" --private-key $K_KRIS --json "$SIDE" "transfer(address,uint256)" "$SAFE" "$TO_SAFE" | jq -r .transactionHash)
budget_hashes "2. dev buy to the Safe" "$TX2"
ok "SIDE $SIDE on nad.fun: 1e9 supply, 18 decimals, permit, no burn; dev buy $BOUGHT wei (~5%), $TO_SAFE to the Safe; the slash recipient accepts SIDE"

# The scratch config: mainnet's, with the fork's roles, the Safe and a v1 sidequest block. Mainnet's own sidequest keys
# (the creator-bond policy) are kept, so R7 deploys the launch values.
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg relay "$RELAY" --arg attester "$ATTESTER" \
  --arg arbitrator "$ARBITRATOR" --arg side "$SIDE" '
  .roles = { admin: $admin, relay: $relay, attester: $attester, arbitrator: $arbitrator }
  | .sidequest = (.sidequest // {}) + {
      safe: $safe, slashRecipient: $safe, defaultArbitrator: $arbitrator, margin: 3600,
      schedule: { thresholds: [0, 1000000, 10000000, 50000000], bps: [3000, 1000, 300, 100], treasury: $safe },
      token: $side }
  | .knownTokens = [.x402.usdc, $side]
  | .deployment = {}' config/monad-mainnet.json >"$CONFIG"

# 2. DeploySidequest (fresh core).
log /tmp/r7-deploy.log env MAINNET_GO=yes forge script script/DeploySidequest.s.sol --rpc-url "$LOCAL" \
  --private-key $K_DEPLOYER --broadcast --slow || fail "DeploySidequest"
budget_run "2. DeploySidequest (fresh core)" DeploySidequest
ok "deployed ($(jq '.transactions | length' "$FOUNDRY_BROADCAST/DeploySidequest.s.sol/$CHAIN/run-latest.json") transactions)"

# 3. PromoteSidequest, then the D16 gate: pending ownership must not open.
log /tmp/r7-promote.log forge script script/PromoteSidequest.s.sol --rpc-url "$LOCAL" || fail "PromoteSidequest"
record "3. PromoteSidequest (reads; writes config)" 0 0 0
[[ "$(jq -r .deployment.main.kind "$CONFIG")" == "sidequest-v1" ]] || fail "promotion did not record the v1 pair"
[[ "$(jq -r .deployment.sidequest.safe "$CONFIG")" == "$SAFE" ]] || fail "promotion did not record the Safe"
[[ "$(jq -r .deployment.sidequest.slashRecipient "$CONFIG")" == "$SAFE" ]] || fail "promotion did not record the slash recipient"
VAULT=$(jq -r .deployment.sidequest.vault "$CONFIG")
[[ "$(cast call --rpc-url "$LOCAL" "$VAULT" "slashRecipient()(address)")" == "$SAFE" ]] || fail "vault slash recipient is not the Safe"
set +e; REFUSED=$(gate); CODE=$?; set -e
[[ $CODE -eq 3 ]] || fail "D16 gate opened before the Safe accepted ($REFUSED)"
[[ "$(jq length <<<"$REFUSED")" == 4 && "$(jq '[.[] | select(endswith("is not the Safe"))] | length' <<<"$REFUSED")" == 4 ]] \
  || fail "D16 gate refused for other reasons: $REFUSED"
ok "promoted; D16 gate refuses with the four handovers pending"
# LAUNCH-AUDIT-004: the config had knownTokens only; the promoted record must give the SDK USDC and SIDE as reward tokens.
bun -e "import { readFileSync } from 'node:fs'; import { deploymentFromConfig } from '$REPO/packages/sdk/src/deployment.ts'
const c = JSON.parse(readFileSync('$PWD/$CONFIG', 'utf8')); const d = deploymentFromConfig('monad-mainnet', c)
const r = d.rewardTokens.map((t) => t.toLowerCase())
process.exit(r.length === 2 && r[0] === c.x402.usdc.toLowerCase() && r[1] === '$SIDE'.toLowerCase() ? 0 : 1)" \
  || fail "the promoted record does not give the SDK USDC and SIDE as reward tokens"
ok "the SDK reads the promoted record's reward tokens: USDC and SIDE, from knownTokens"

# 4. SafeAccept, then the D16 gate passes.
log /tmp/r7-accept.log env MAINNET_GO=yes forge script script/SafeAccept.s.sol --rpc-url "$LOCAL" \
  --private-key $K_OWNER1 --broadcast --slow || fail "SafeAccept"
budget_run "4. SafeAccept (4 execTransactions)" SafeAccept
log /tmp/r7-accept-check.log forge script script/SafeAccept.s.sol --sig "check()" --rpc-url "$LOCAL" || fail "SafeAccept check"
gate >/tmp/r7-gate.log || fail "D16 gate refused after SafeAccept: $(cat /tmp/r7-gate.log)"
ok "the Safe owns all four; D16 gate passes (reviewed Safe: canonical 1.4.1, pinned owners/threshold, no module, no guard; custody, core roles, verifier, relay above RELAY_FLOOR_MAINNET)"
# LAUNCH-AUDIT-003 on the fork: a pinned owner set the Safe does not have, then a guard, each refuse.
set +e; REFUSED=$(gate "{\"owners\":[\"$OWNER1\",\"$TEAM\"],\"threshold\":1}"); CODE=$?; set -e
[[ $CODE -eq 3 && "$REFUSED" == '["launch:safe owners differ from the pinned set"]' ]] || fail "a wrong owner pin did not refuse: $REFUSED"
GUARD_SLOT=0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8
cast rpc --rpc-url "$LOCAL" anvil_setStorageAt "$SAFE" $GUARD_SLOT "$(cast to-uint256 "$TEAM")" >/dev/null
set +e; REFUSED=$(gate); CODE=$?; set -e
cast rpc --rpc-url "$LOCAL" anvil_setStorageAt "$SAFE" $GUARD_SLOT "$(cast to-uint256 0)" >/dev/null
[[ $CODE -eq 3 && "$REFUSED" == '["launch:safe has a guard set"]' ]] || fail "a Safe guard did not refuse: $REFUSED"
gate >/tmp/r7-gate.log || fail "D16 gate refused once the guard was cleared: $(cat /tmp/r7-gate.log)"
ok "D16 refuses a wrong pinned owner set and a Safe guard; passes again once cleared"

# 5. By 20 Oct the 1-of-1 Safe becomes 2-of-3 in place: two execTransactions from the owner while the threshold is 1.
#    Not a launch-day step, so it is reported apart from the launch budget.
SIG="0x$(printf '%064s' "${OWNER1#0x}" | tr ' ' 0)$(printf '%064d' 0)01"
TX=$(cast send --rpc-url "$LOCAL" --private-key $K_OWNER1 --json "$SAFE" \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  "$SAFE" 0 "$(cast calldata 'addOwnerWithThreshold(address,uint256)' "$OWNER2" 1)" 0 0 0 0 $ZERO $ZERO "$SIG" | jq -r .transactionHash)
TX2=$(cast send --rpc-url "$LOCAL" --private-key $K_OWNER1 --json "$SAFE" \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  "$SAFE" 0 "$(cast calldata 'addOwnerWithThreshold(address,uint256)' "$OWNER3" 2)" 0 0 0 0 $ZERO $ZERO "$SIG" | jq -r .transactionHash)
budget_hashes "5. after launch, by 20 Oct: Safe 1-of-1 to 2-of-3 (addOwnerWithThreshold x2)" "$TX" "$TX2"
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "getThreshold()(uint256)")" == "2" ]] || fail "the Safe threshold did not move to 2"
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "getOwners()(address[])" | tr -cd ',' | wc -c)" -eq 2 ]] || fail "the Safe does not have three owners"
set +e; REFUSED=$(gate); CODE=$?; set -e
[[ $CODE -eq 3 ]] || fail "D16 passed with the 1-of-1 pin: $REFUSED"
POLICY="{\"owners\":[\"$OWNER3\",\"$OWNER2\",\"$OWNER1\"],\"threshold\":2}"
gate >/tmp/r7-gate.log || fail "D16 refused the 2-of-3 Safe with its new pin: $(cat /tmp/r7-gate.log)"
ok "the Safe went 1-of-1 to 2-of-3 in place; D16 refuses the stale pin ($REFUSED) and passes the new one"

# 6. One direct hire.
log /tmp/r7-hire.log env MAINNET_GO=yes FUNDER_KEY=$K_KRIS CREATOR_KEY=$K_CREATOR WORKER_KEY=$K_WORKER \
  forge script script/RehearseHire.s.sol --tc RehearseHire --rpc-url "$LOCAL" --broadcast --slow || fail "hire"
budget_run "6. Two SIDE hires (fund, register, stake, publish, activate; one delivered and settled)" RehearseHire
ok "hire settled in SIDE ($(grep -o 'net to worker [0-9]*' /tmp/r7-hire.log))"
MISSED=$(grep -o 'slash job [0-9]*' /tmp/r7-hire.log | awk '{print $3}')
[[ -n "$MISSED" ]] || fail "the hire run did not report the undelivered job"
cast rpc --rpc-url "$LOCAL" evm_increaseTime $((86400 + 60)) >/dev/null
cast rpc --rpc-url "$LOCAL" evm_mine >/dev/null
log /tmp/r7-slash.log env MAINNET_GO=yes CREATOR_KEY=$K_CREATOR \
  forge script script/RehearseHire.s.sol --tc RehearseSlash --sig "run(uint256)" "$MISSED" --rpc-url "$LOCAL" \
  --broadcast --slow || fail "missed-delivery slash"
budget_run "6. Missed delivery (rejectAfterDeliveryDeadline, settle)" RehearseHire
ok "job $MISSED missed its deadline; $(grep -o 'slashed to the recipient [0-9]*' /tmp/r7-slash.log) SIDE wei"

# 7. A small buy and sell of SIDE through the router: the exit path works.
NOW=$(cast block --rpc-url "$LOCAL" latest -f timestamp)
BEFORE=$(cast call --rpc-url "$LOCAL" "$SIDE" "balanceOf(address)(uint256)" "$KRIS" | awk '{print $1}')
TX=$(cast send --rpc-url "$LOCAL" --private-key $K_KRIS --json --value "$(cast to-wei 1)" $NADFUN_ROUTER \
  "buyWithNative((uint256,address,address,uint256))" "(0,$SIDE,$KRIS,$((NOW + 600)))" | jq -r .transactionHash)
AFTER=$(cast call --rpc-url "$LOCAL" "$SIDE" "balanceOf(address)(uint256)" "$KRIS" | awk '{print $1}')
GOT=$(python3 -c "import sys; print(int(sys.argv[2]) - int(sys.argv[1]))" "$BEFORE" "$AFTER")
python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) > 0 else 1)" "$GOT" || fail "the buy returned no SIDE"
TX2=$(cast send --rpc-url "$LOCAL" --private-key $K_KRIS --json "$SIDE" "approve(address,uint256)" $NADFUN_ROUTER "$GOT" | jq -r .transactionHash)
MON_BEFORE=$(cast balance --rpc-url "$LOCAL" "$KRIS")
TX3=$(cast send --rpc-url "$LOCAL" --private-key $K_KRIS --json $NADFUN_ROUTER \
  "sellToNative((uint256,uint256,address,address,uint256))" "($GOT,0,$SIDE,$KRIS,$((NOW + 600)))" | jq -r .transactionHash)
[[ "$(cast receipt --rpc-url "$LOCAL" "$TX3" status)" =~ ^(1|true|1\ \(success\))$ ]] || fail "the sell reverted"
budget_hashes "7. Small buy and sell on nad.fun" "$TX" "$TX2" "$TX3"
ok "bought $GOT SIDE wei for 1 MON and sold it back (MON before the sell: $MON_BEFORE)"

# 8. The creator fee goes to the Safe: the vault names it as SIDE's recipient. The claim itself is not rehearsable here:
#    nad.fun credits the vault only when its operator runs FeeCollector.collectFee (anyone else gets NotAuthorized), so
#    the Safe's claim(token) is checked live after the first collection.
RECIPIENT=$(cast call --rpc-url "$LOCAL" $CREATOR_FEE_VAULT "getCreator(address)(address)" "$SIDE")
[[ "${RECIPIENT,,}" == "${SAFE,,}" ]] || fail "the creator-fee vault names $RECIPIENT, not the Safe, as SIDE's recipient"
ok "the creator-fee vault names the Safe as SIDE's recipient"

echo
echo "LAUNCH BUDGET (Monad charges the gas limit; MON at 102 gwei now, and at forge's 203 gwei max fee)"
printf '%-78s %4s %12s %12s %10s %10s\n' step txs "gas limit" "gas used" "MON@102" "MON@203"
awk -F'\t' '{ printf "%-78s %4d %12d %12d %10.4f %10.4f\n", $1, $2, $3, $4, $3*102e-9, $3*203e-9; n+=$2; l+=$3; u+=$4 }
  END { printf "%-78s %4d %12d %12d %10.4f %10.4f\n", "total", n, l, u, l*102e-9, l*203e-9 }' "$BUDGET"
[[ "$(real_logs "$CHAIN")" == "$REAL_LOGS" ]] || fail "a chain-$CHAIN forge log outside this run's directories changed"
ok "no chain-$CHAIN forge log outside $FOUNDRY_BROADCAST and $FOUNDRY_CACHE_PATH was touched"
echo "LAUNCH REHEARSAL PASSED"
exit
}
