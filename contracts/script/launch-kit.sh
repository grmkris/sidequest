#!/usr/bin/env bash
# Sidequest launch kit: the launch steps signed by keys on Kris's MacBook (myplan note 22, 12 Oct; note 23's [Mac] steps).
#
# A Claude Code session on the Mac runs every step twice. `plan` reads, uploads and simulates, and signs nothing.
# `send` re-checks, asks Keychain for the keystore password (that macOS prompt is Kris's approval: click Allow, never
# Always Allow), sends, waits for the receipt and reads the result back. A mainnet `send` also needs MAINNET_GO=yes.
#
#   NETWORK=monad-testnet|monad-mainnet contracts/script/launch-kit.sh <command> [...]
#
#   setup                          Kris, in Terminal: create the owner, creator and exit-test keystores (passwords to Keychain)
#   addresses | balances
#   copy-password <name>           a keystore password on the clipboard for 60 s, for the Passwords app backup
#   backup <dir>                   copy the keystores and addresses.json into <dir>
#   safe plan|send                 L2: a 1-of-1 Safe owned by the owner keystore (canonical v1.4.1, no module, no guard)
#   token plan|send                L3: SIDE through nad.fun's upload and salt API and the V2 router; creator fee to the Safe
#   move plan|send [wei]           L4: the creator's SIDE (all of it by default) to the Safe
#   accept plan|send               L7: SafeAccept.s.sol from the owner keystore
#   backing plan|send <file.json>  L10: approve + delegateFor from the Safe in one MultiSendCallOnly batch;
#                                  the file is [{"account": "0x…", "side": "5000000"}, …] in whole SIDE
#   exit buy|sell plan|send <amt>  L12b: the exit-test wallet buys with <amt> MON, or sells <amt> SIDE (all by default)
#
# Addresses come from contracts/config/<network>.json (`nadfun`, `launchKit`, `sidequest`, `deployment`). Keystores,
# plans and receipts live in $KIT_HOME (default ~/.sidequest-kit). Runs on macOS bash 3.2 and on Linux; needs cast,
# forge, jq, curl, bc and openssl.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NETWORK=${NETWORK:?set NETWORK=monad-testnet or monad-mainnet}
CONFIG="$ROOT/contracts/config/$NETWORK.json"
[[ -f "$CONFIG" ]] || { echo "launch-kit: no config for $NETWORK" >&2; exit 2; }
KIT_HOME=${KIT_HOME:-$HOME/.sidequest-kit}
KEYS="$KIT_HOME/keystores"
STATE="$KIT_HOME/$NETWORK"
ZERO=0x0000000000000000000000000000000000000000
NAMES="owner creator exit-test"
EXEC="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
CREATE="createWithNative((string,string,string,address,uint16,(address,uint16,bytes)[],bytes32,uint8,uint256,uint256))"

die() { echo "launch-kit: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
cfg() { jq -r "$1 // empty" "$CONFIG"; }
# nad.fun: mainnet keeps the deploy recipe's `nadfun` block; `launchKit.nadfun` adds the API and the protocol manager.
nadfun() { jq -r --arg k "$1" '((.nadfun // {}) + (.launchKit.nadfun // {}))[$k] // empty' "$CONFIG"; }
CHAIN=$(cfg .chainId)
RPC=${KIT_RPC:-$(cfg .launchKit.rpc)}
EXPLORER=$(cfg .launchKit.explorer)
mainnet() { [[ "$CHAIN" == 143 ]]; }
calc() { echo "$1" | BC_LINE_LENGTH=0 bc; }
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
num() { awk '{print $1}' <<<"$1"; } # cast prints "123 [1.23e2]"
now() { cast block --rpc-url "$RPC" latest -f timestamp; }
addr() {
  [[ -f "$KIT_HOME/addresses.json" ]] || die "no keystores yet: Kris runs \`setup\` first"
  jq -r --arg n "$1" '.[$n] // empty' "$KIT_HOME/addresses.json"
}
code_at() { cast code --rpc-url "$RPC" "$1"; }
side_balance() { num "$(cast call --rpc-url "$RPC" "$1" 'balanceOf(address)(uint256)' "$2")"; }
save() { mkdir -p "$STATE" && chmod 700 "$KIT_HOME" "$STATE" && (umask 077 && cat >"$STATE/$1"); }
link() { say "  $EXPLORER/$1/$2"; }

# The Safe: SAFE=, else the one `safe send` made, else the promoted or configured one.
safe_addr() {
  local s=${SAFE:-}
  [[ -n "$s" || ! -f "$STATE/safe.json" ]] || s=$(jq -r .safe "$STATE/safe.json")
  [[ -n "$s" ]] || s=$(cfg .deployment.sidequest.safe)
  [[ -n "$s" ]] || s=$(cfg .sidequest.safe)
  [[ -n "$s" ]] || die "no Safe: run \`safe send\` or set SAFE="
  echo "$s"
}
# SIDE: SIDE=, else the token `token send` made, else the promoted or configured one.
side_token() {
  local t=${SIDE:-}
  [[ -n "$t" || ! -f "$STATE/token.json" ]] || t=$(jq -r '.token // empty' "$STATE/token.json")
  [[ -n "$t" ]] || t=$(cfg .deployment.sidequest.factory)
  [[ -n "$t" ]] || t=$(cfg .sidequest.token)
  [[ -n "$t" ]] || die "no SIDE token yet"
  echo "$t"
}
# On mainnet the fee recipient and every Safe action must be our 1-of-1 Safe.
check_safe() {
  local safe=$1 owners
  [[ "$(cast call --rpc-url "$RPC" "$safe" 'VERSION()(string)')" == '"1.4.1"' ]] || die "$safe is not a Safe v1.4.1"
  mainnet || return 0
  owners=$(cast call --rpc-url "$RPC" "$safe" 'getOwners()(address[])')
  [[ "$(lower "$owners")" == "[$(lower "$(addr owner)")]" ]] || die "Safe $safe owners are $owners, not the owner keystore"
}

# Keystore passwords: macOS Keychain items with no trusted application, so every read shows Kris a prompt. Elsewhere
# (the agent's testnet dry run on netcup), mode-600 files under $KIT_HOME/secrets.
secret_store() {
  if [[ "$(uname)" == Darwin ]]; then
    security add-generic-password -U -a sidequest -s "sidequest-$1" -l "Sidequest $1 keystore" -T "" -w "$2"
  else
    (umask 077 && mkdir -p "$KIT_HOME/secrets" && printf '%s' "$2" >"$KIT_HOME/secrets/sidequest-$1.password")
  fi
}
secret_read() {
  if [[ "$(uname)" == Darwin ]]; then
    security find-generic-password -a sidequest -s "sidequest-$1" -w
  else
    cat "$KIT_HOME/secrets/sidequest-$1.password"
  fi
}
PWDIR=
PWFILE=
trap '[[ -z "$PWDIR" ]] || rm -rf "$PWDIR"' EXIT
# One Keychain prompt per `send`: the password goes to a private temp file (foundry reads only regular files),
# removed on exit.
unlock() {
  PWDIR=$(mktemp -d "${TMPDIR:-/tmp}/sqkit.XXXXXX")
  chmod 700 "$PWDIR"
  PWFILE="$PWDIR/pw"
  (umask 077 && secret_read "$1" >"$PWFILE") || die "no password for $1 (Keychain prompt denied?)"
}
go_check() {
  mainnet || return 0
  [[ "${MAINNET_GO:-}" == yes ]] || die "a mainnet send needs MAINNET_GO=yes, given only after Kris's go on the launch desk"
  [[ "$(jq -r .testnetOnly "$KIT_HOME/addresses.json")" != true ]] || die "these keystores were made by an agent for a testnet dry run"
}
# Estimate, then send from a kit keystore with a 25% gas margin (Monad charges the gas limit). Sets LAST_HASH.
LAST_HASH=
send_tx() {
  local name=$1 to=$2 value=$3 from est out status
  shift 3
  from=$(addr "$name")
  est=$(cast estimate --rpc-url "$RPC" --from "$from" --value "$value" "$to" "$@") || die "the estimate reverted: not sent"
  out=$(cast send --rpc-url "$RPC" --keystore "$KEYS/sidequest-$name" --password-file "$PWFILE" --value "$value" \
    --gas-limit "$(calc "$est * 125 / 100")" --json "$to" "$@") || die "the send failed"
  LAST_HASH=$(jq -r .transactionHash <<<"$out")
  status=$(jq -r .status <<<"$out")
  [[ "$status" == 0x1 || "$status" == 1 ]] || die "transaction $LAST_HASH reverted"
  say "sent $LAST_HASH"
  link tx "$LAST_HASH"
}

cmd_setup() {
  local agent=false json='{}' name pw out a
  if [[ -n "${CLAUDECODE:-}" ]]; then
    # Agents never make prod keys. The only agent setup is a throwaway testnet dry run, marked so mainnet refuses it.
    [[ "${KIT_AGENT_DRY_RUN:-}" == testnet-only ]] && ! mainnet || die "setup makes keys: Kris runs it himself in Terminal"
    agent=true
  fi
  [[ ! -f "$KIT_HOME/addresses.json" ]] || die "already set up ($KIT_HOME/addresses.json exists)"
  mkdir -p "$KEYS" && chmod 700 "$KIT_HOME" "$KEYS"
  for name in $NAMES; do
    pw=$(openssl rand -base64 33 | tr -d '\n+/=')
    secret_store "$name" "$pw"
    out=$(CAST_PASSWORD="$pw" cast wallet new "$KEYS" "sidequest-$name")
    unset pw
    a=$(grep -Eo '0x[0-9a-fA-F]{40}' <<<"$out" | head -1)
    [[ -n "$a" ]] || die "no address from cast wallet new"
    json=$(jq --arg n "$name" --arg a "$a" '. + {($n): $a}' <<<"$json")
  done
  jq --argjson t "$agent" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {testnetOnly: $t, createdAt: $at}' <<<"$json" \
    | (umask 077 && cat >"$KIT_HOME/addresses.json")
  cmd_addresses
  say ""
  say "Back up now: copy each password into the Passwords app (\`copy-password owner\`, then creator and exit-test),"
  say "and copy the keystores to an encrypted place (\`backup <dir>\`). Send Claude the three addresses above."
}

cmd_addresses() {
  local name
  for name in $NAMES; do printf '%-10s %s\n' "$name" "$(addr "$name")"; done
  [[ "$(jq -r .testnetOnly "$KIT_HOME/addresses.json")" != true ]] || say "(testnet dry-run keystores: mainnet refuses them)"
}

cmd_balances() {
  local token= safe= name a
  token=$(side_token 2>/dev/null) || token=
  safe=$(safe_addr 2>/dev/null) || safe=
  for name in $NAMES safe; do
    if [[ $name == safe ]]; then a=$safe; else a=$(addr "$name"); fi
    [[ -n "$a" ]] || continue
    printf '%-10s %s  %s MON' "$name" "$a" "$(cast balance --ether --rpc-url "$RPC" "$a")"
    [[ -z "$token" ]] || printf '  %s SIDE' "$(cast from-wei "$(side_balance "$token" "$a")")"
    printf '\n'
  done
}

cmd_copy_password() {
  [[ "$(uname)" == Darwin ]] || die "copy-password is for the Mac"
  [[ " $NAMES " == *" ${1:-} "* ]] || die "usage: copy-password owner|creator|exit-test"
  secret_read "$1" | tr -d '\n' | pbcopy
  (sleep 60 && pbcopy </dev/null) &
  say "The $1 password is on the clipboard for 60 seconds: paste it into the Passwords app as \"Sidequest $1 keystore\"."
}

cmd_backup() {
  local dir=${1:?usage: backup <dir>}
  mkdir -p "$dir/sidequest-kit" && chmod 700 "$dir/sidequest-kit"
  cp -R "$KEYS" "$KIT_HOME/addresses.json" "$dir/sidequest-kit/"
  say "Copied the encrypted keystores and addresses.json to $dir/sidequest-kit (passwords are not included)."
}

# L2: a 1-of-1 Safe, created by the owner keystore through the canonical factory. The salt nonce is fixed per owner
# and network, so a second send cannot make a second Safe.
safe_inputs() {
  OWNER=$(addr owner)
  FACTORY=$(cfg .launchKit.safe.proxyFactory)
  SETUP=$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' "[$OWNER]" 1 $ZERO 0x \
    "$(cfg .launchKit.safe.fallbackHandler)" $ZERO 0 $ZERO)
  NONCE=$(cast to-dec "$(cast keccak "sidequest-safe:$NETWORK:$(lower "$OWNER")")")
  PREDICTED=$(cast call --rpc-url "$RPC" --from "$OWNER" "$FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' \
    "$(cfg .launchKit.safe.singletonL2)" "$SETUP" "$NONCE") || die "the Safe creation simulation reverted (does it exist already?)"
}
cmd_safe() {
  safe_inputs
  say "Creates a Safe v1.4.1 at $PREDICTED: one owner, $OWNER (the owner keystore), threshold 1, no module, no guard."
  [[ "${1:-}" == send ]] || return 0
  go_check
  unlock owner
  send_tx owner "$FACTORY" 0 'createProxyWithNonce(address,bytes,uint256)' "$(cfg .launchKit.safe.singletonL2)" "$SETUP" "$NONCE"
  [[ "$(cast call --rpc-url "$RPC" "$PREDICTED" 'getThreshold()(uint256)')" == 1 ]] || die "Safe threshold is not 1"
  [[ "$(cast call --rpc-url "$RPC" "$PREDICTED" 'getModulesPaginated(address,uint256)(address[],address)' \
    0x0000000000000000000000000000000000000001 10 | head -1)" == "[]" ]] || die "the new Safe has a module"
  # keccak256("guard_manager.guard.address"), the Safe's guard slot.
  [[ "$(cast to-dec "$(cast storage --rpc-url "$RPC" "$PREDICTED" \
    0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)")" == 0 ]] || die "the new Safe has a guard"
  SAFE=$PREDICTED check_safe "$PREDICTED"
  jq -n --arg s "$PREDICTED" --arg o "$OWNER" --arg h "$LAST_HASH" '{safe: $s, owner: $o, hash: $h}' | save safe.json
  say "Safe $PREDICTED created (1-of-1, owner $OWNER)."
}

# L3. nad.fun lists only tokens whose metadata and salt come from its API (research 12 Oct), the tokenURI is permanent,
# and the address depends only on the salt, so the salt stays in $STATE until the send.
cmd_token_plan() {
  local api creator safe meta image name symbol buy margin img image_uri body res muri stored sj salt predicted computed
  api=$(nadfun api)
  creator=$(addr creator)
  safe=$(safe_addr)
  check_safe "$safe"
  meta="$ROOT/docs/brand/nadfun-token.json"
  image="$ROOT/docs/brand/$(jq -r .image "$meta")"
  if mainnet; then
    name=Sidequest symbol=SIDE buy=$(cast to-wei "${KIT_DEV_BUY_MON:-3544}") margin=$(cast to-wei 10)
  else
    name=${KIT_TOKEN_NAME:-Sidequest Test} symbol=${KIT_TOKEN_SYMBOL:-SQTEST}
    buy=$(cast to-wei "${KIT_DEV_BUY_MON:-0.05}") margin=$(cast to-wei 0.1)
  fi
  img=$(curl -sSf -X POST "$api/metadata/image" -H 'Content-Type: image/png' --data-binary @"$image") || die "image upload failed"
  [[ "$(jq -r .is_nsfw <<<"$img")" == false ]] || die "nad.fun flagged the image: $img"
  image_uri=$(jq -r .image_uri <<<"$img")
  [[ "$image_uri" == https://storage.nadapp.net/* ]] || die "unexpected image_uri $image_uri"
  body=$(jq -n --arg i "$image_uri" --arg n "$name" --arg s "$symbol" --slurpfile m "$meta" \
    '$m[0] | {image_uri: $i, name: $n, symbol: $s, description, website, twitter, telegram}')
  res=$(curl -sSf -X POST "$api/metadata/metadata" -H 'Content-Type: application/json' --data-binary "$body") \
    || die "metadata upload failed"
  muri=$(jq -r .metadata_uri <<<"$res")
  stored=$(curl -sSf "$muri") || die "cannot read back $muri"
  jq -e --argjson want "$body" '. as $got | ($want | to_entries | all(.value == $got[.key]))' <<<"$stored" >/dev/null \
    || die "nad.fun stored different metadata: $stored"
  sj=$(jq -n --arg c "$creator" --arg n "$name" --arg s "$symbol" --arg m "$muri" \
    '{creator: $c, name: $n, symbol: $s, metadata_uri: $m, version: "V2"}' \
    | curl -sSf -X POST "$api/token/salt" -H 'Content-Type: application/json' --data-binary @-) || die "salt request failed"
  salt=$(jq -r .salt <<<"$sj")
  predicted=$(jq -r .address <<<"$sj")
  impl=$(nadfun tokenImplementation)
  computed=$(cast create2 --deployer "$(nadfun curve)" --salt "$salt" \
    --init-code "0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl#0x}5af43d82803e903d91602b57fd5bf3" | awk '{print $1}')
  [[ "$(lower "$computed")" == "$(lower "$predicted")" ]] || die "salt does not give $predicted (computed $computed)"
  [[ "$(lower "$predicted")" == *7777 ]] || { mainnet && die "$predicted does not end in 7777"; say "note: $predicted does not end in 7777"; }
  [[ "$(code_at "$predicted")" == 0x ]] || die "$predicted already has code: the salt was used"
  jq -n --arg name "$name" --arg symbol "$symbol" --arg muri "$muri" --arg image "$image_uri" --arg salt "$salt" \
    --arg predicted "$predicted" --arg buy "$buy" --arg margin "$margin" --arg safe "$safe" --arg creator "$creator" \
    '{name: $name, symbol: $symbol, metadataUri: $muri, imageUri: $image, salt: $salt, predicted: $predicted,
      buy: $buy, margin: $margin, safe: $safe, creator: $creator}' | save token-plan.json
  token_simulate
  say "Plan saved ($STATE/token-plan.json). The salt is private until \`token send\`: never post it or the address."
}
# Builds the createWithNative params from the plan with a fresh fee and deadline, and simulates them. Sets PARAMS, VALUE.
token_simulate() {
  local p fee sim token out rich=()
  p="$STATE/token-plan.json"
  [[ -f "$p" ]] || die "no token plan: run \`token plan\`"
  fee=$(num "$(cast call --rpc-url "$RPC" "$(nadfun protocolManager)" 'deployFee(address)(uint256)' "$(nadfun wmon)")")
  VALUE=$(calc "$fee + $(jq -r .buy "$p") + $(jq -r .margin "$p")")
  PARAMS="($(jq -r .name "$p"),$(jq -r .symbol "$p"),$(jq -r .metadataUri "$p"),$(nadfun wmon),100,[($(nadfun creatorFeeVault),10000,$(cast abi-encode 'f(address)' "$(jq -r .safe "$p")"))],$(jq -r .salt "$p"),0,$(jq -r .buy "$p"),$(($(now) + 600)))"
  [[ "${KIT_SIMULATE_RICH:-}" != 1 ]] || rich=(--override-balance "$(jq -r .creator "$p"):$(calc "$VALUE * 2")")
  sim=$(cast call --rpc-url "$RPC" --from "$(jq -r .creator "$p")" --value "$VALUE" "${rich[@]+"${rich[@]}"}" \
    "$(nadfun router)" "$CREATE(address,uint256)" "$PARAMS") || die "the createWithNative simulation reverted (creator funded?)"
  token=$(sed -n 1p <<<"$sim")
  out=$(num "$(sed -n 2p <<<"$sim")")
  [[ "$(lower "$token")" == "$(lower "$(jq -r .predicted "$p")")" ]] || die "simulation made $token, not the predicted address"
  say "Creates $(jq -r .name "$p") ($(jq -r .symbol "$p")) at $token from the creator $(jq -r .creator "$p")."
  say "Dev buy: $(cast from-wei "$(jq -r .buy "$p")") MON for $(cast from-wei "$out") $(jq -r .symbol "$p") ($(calc "scale=2; $out * 100 / 10^27")% of 1e9); deploy fee $(cast from-wei "$fee") MON; send value $(cast from-wei "$VALUE") MON (the excess is refunded)."
  say "Creator fee to the Safe $(jq -r .safe "$p"). Metadata (permanent): $(jq -r .metadataUri "$p")"
}
cmd_token_send() {
  local p token api i listed=
  go_check
  p="$STATE/token-plan.json"
  [[ "$(code_at "$(jq -r .predicted "$p")")" == 0x ]] || die "the predicted address already has code"
  token_simulate
  unlock creator
  send_tx creator "$(nadfun router)" "$VALUE" "$CREATE" "$PARAMS"
  token=$(jq -r .predicted "$p")
  [[ "$(code_at "$token")" != 0x ]] || die "no code at $token after the send"
  [[ "$(cast call --rpc-url "$RPC" "$token" 'decimals()(uint8)')" == 18 ]] || die "decimals is not 18"
  [[ "$(num "$(cast call --rpc-url "$RPC" "$token" 'totalSupply()(uint256)')")" == 1000000000000000000000000000 ]] || die "supply is not 1e9"
  [[ "$(lower "$(cast call --rpc-url "$RPC" "$(nadfun creatorFeeVault)" 'getCreator(address)(address)' "$token")")" \
    == "$(lower "$(jq -r .safe "$p")")" ]] || die "the creator-fee recipient is not the Safe"
  jq --arg t "$token" --arg h "$LAST_HASH" '. + {token: $t, hash: $h}' "$p" | save token.json
  say "$(cast call --rpc-url "$RPC" "$token" 'name()(string)') at $token; the creator holds $(cast from-wei "$(side_balance "$token" "$(jq -r .creator "$p")")"); creator fee to the Safe."
  api=$(nadfun api)
  for i in 1 2 3 4 5 6; do
    if curl -sSf "$api/token/$token" >/dev/null 2>&1; then listed=yes && break; fi
    sleep 10
  done
  if [[ -n "$listed" ]]; then say "Listed on nad.fun: $(nadfun app)/tokens/$token"; else say "Not listed on nad.fun's API after 60 s; check again."; fi
}

# L4: the creator's SIDE (the dev buy) to the Safe.
cmd_move() {
  local token creator safe amount
  token=$(side_token)
  creator=$(addr creator)
  safe=$(safe_addr)
  check_safe "$safe"
  amount=${2:-$(side_balance "$token" "$creator")}
  [[ "$amount" != 0 ]] || die "the creator holds no SIDE"
  cast call --rpc-url "$RPC" --from "$creator" "$token" 'transfer(address,uint256)(bool)' "$safe" "$amount" >/dev/null \
    || die "the transfer simulation reverted"
  say "Moves $(cast from-wei "$amount") SIDE from the creator $creator to the Safe $safe."
  [[ "${1:-}" == send ]] || return 0
  go_check
  unlock creator
  send_tx creator "$token" 0 'transfer(address,uint256)' "$safe" "$amount"
  say "The Safe now holds $(cast from-wei "$(side_balance "$token" "$safe")") SIDE."
}

# L7: SafeAccept.s.sol, sent by the owner keystore (one execTransaction per pending contract).
cmd_accept() {
  local owner safe
  owner=$(addr owner)
  safe=$(safe_addr)
  check_safe "$safe"
  # SafeAccept.s.sol reads the promoted Safe from the config; it must be the kit's Safe.
  [[ "$(lower "$(cfg .deployment.sidequest.safe)")" == "$(lower "$safe")" ]] \
    || die "the config's promoted Safe ($(cfg .deployment.sidequest.safe)) is not $safe: pull the promotion commit"
  if [[ "${1:-}" != send ]]; then
    (cd "$ROOT/contracts" && NETWORK=$NETWORK forge script script/SafeAccept.s.sol --rpc-url "$RPC" --sender "$owner")
    return 0
  fi
  go_check
  unlock owner
  (cd "$ROOT/contracts" && NETWORK=$NETWORK MAINNET_GO=${MAINNET_GO:-} forge script script/SafeAccept.s.sol \
    --rpc-url "$RPC" --keystore "$KEYS/sidequest-owner" --password-file "$PWFILE" --sender "$owner" --broadcast --slow)
  (cd "$ROOT/contracts" && NETWORK=$NETWORK forge script script/SafeAccept.s.sol --sig 'check()' --rpc-url "$RPC")
}

# The owner's pre-validated signature: a 1-of-1 Safe accepts r = owner, s = 0, v = 1 when the owner sends the tx.
owner_signature() { echo "0x$(printf '%064s' "$(lower "${1#0x}")" | tr ' ' 0)$(printf '%064d' 0)01"; }

# L10: one Safe transaction: approve(vault, total) on SIDE, then delegateFor(account, Safe, amount) per row.
cmd_backing() {
  local mode=${1:-} file=${2:-} owner safe token vault multisend total=0 packed= rows i account side wei call data sig before
  [[ -f "$file" ]] || die "usage: backing plan|send <file.json>"
  owner=$(addr owner)
  safe=$(safe_addr)
  check_safe "$safe"
  token=$(side_token)
  vault=$(cfg .deployment.sidequest.vault)
  [[ -n "$vault" ]] || die "no promoted StakeVault in the config"
  multisend=$(cfg .launchKit.safe.multiSendCallOnly)
  rows=$(jq length "$file")
  for ((i = 0; i < rows; i++)); do
    total=$(calc "$total + $(cast to-wei "$(jq -r ".[$i].side" "$file")")")
  done
  pack() { # to calldata: MultiSend's operation(0) | to | value(0) | length | data
    local d=${2#0x}
    packed="$packed""00$(lower "${1#0x}")$(printf '%064d' 0)$(printf '%064x' $((${#d} / 2)))$d"
  }
  pack "$token" "$(cast calldata 'approve(address,uint256)' "$vault" "$total")"
  say "From the Safe $safe, one batch:"
  say "  approve the StakeVault $vault for $(cast from-wei "$total") SIDE"
  for ((i = 0; i < rows; i++)); do
    account=$(jq -r ".[$i].account" "$file")
    side=$(jq -r ".[$i].side" "$file")
    wei=$(cast to-wei "$side")
    pack "$vault" "$(cast calldata 'delegateFor(address,address,uint256)' "$account" "$safe" "$wei")"
    say "  delegateFor $account: $side SIDE, the Safe as delegator (the Safe keeps the position)"
  done
  data=$(cast calldata 'multiSend(bytes)' "0x$packed")
  sig=$(owner_signature "$owner")
  [[ "$(cast call --rpc-url "$RPC" --from "$owner" "$safe" "$EXEC(bool)" "$multisend" 0 "$data" 1 0 0 0 $ZERO $ZERO "$sig")" == true ]] \
    || die "the batch simulation failed"
  say "Simulated: OK."
  [[ "$mode" == send ]] || return 0
  go_check
  before=$(side_balance "$token" "$safe")
  unlock owner
  send_tx owner "$safe" 0 "$EXEC" "$multisend" 0 "$data" 1 0 0 0 $ZERO $ZERO "$sig"
  say "The Safe's free SIDE went from $(cast from-wei "$before") to $(cast from-wei "$(side_balance "$token" "$safe")")."
  for ((i = 0; i < rows; i++)); do
    account=$(jq -r ".[$i].account" "$file")
    say "  $account now has $(cast from-wei "$(num "$(cast call --rpc-url "$RPC" "$vault" 'stakeOf(address)(uint256)' "$account")")") SIDE staked"
  done
}

# L12b: the exit-test wallet buys with MON, then sells SIDE, through nad.fun's router, 5% slippage.
cmd_exit() {
  local side=${1:-} mode=${2:-} amount=${3:-} token router who quote min deadline
  token=$(side_token)
  router=$(nadfun router)
  who=$(addr exit-test)
  deadline=$(($(now) + 600))
  case "$side" in
    buy)
      [[ -n "$amount" ]] || die "usage: exit buy plan|send <MON>"
      amount=$(cast to-wei "$amount")
      quote=$(num "$(cast call --rpc-url "$RPC" "$router" 'getAmountOut(address,uint256,bool)(uint256)' "$token" "$amount" true)")
      min=$(calc "$quote * 95 / 100")
      cast call --rpc-url "$RPC" --from "$who" --value "$amount" "$router" 'buyWithNative((uint256,address,address,uint256))(uint256)' \
        "($min,$token,$who,$deadline)" >/dev/null || die "the buy simulation reverted (exit-test funded?)"
      say "The exit-test wallet $who buys about $(cast from-wei "$quote") SIDE for $(cast from-wei "$amount") MON (at least $(cast from-wei "$min"))."
      [[ "$mode" == send ]] || return 0
      go_check
      unlock exit-test
      send_tx exit-test "$router" "$amount" 'buyWithNative((uint256,address,address,uint256))' "($min,$token,$who,$deadline)"
      ;;
    sell)
      [[ -n "$amount" && "$amount" != all ]] && amount=$(cast to-wei "$amount") || amount=$(side_balance "$token" "$who")
      [[ "$amount" != 0 ]] || die "the exit-test wallet holds no SIDE"
      quote=$(num "$(cast call --rpc-url "$RPC" "$router" 'getAmountOut(address,uint256,bool)(uint256)' "$token" "$amount" false)")
      min=$(calc "$quote * 95 / 100")
      say "The exit-test wallet $who sells $(cast from-wei "$amount") SIDE for about $(cast from-wei "$quote") MON (at least $(cast from-wei "$min")): approve, then sellToNative."
      [[ "$mode" == send ]] || return 0
      go_check
      unlock exit-test
      send_tx exit-test "$token" 0 'approve(address,uint256)' "$router" "$amount"
      send_tx exit-test "$router" 0 'sellToNative((uint256,uint256,address,address,uint256))' "($amount,$min,$token,$who,$deadline)"
      ;;
    *) die "usage: exit buy|sell plan|send <amount>" ;;
  esac
  say "The exit-test wallet holds $(cast balance --ether --rpc-url "$RPC" "$who") MON and $(cast from-wei "$(side_balance "$token" "$who")") SIDE."
}

case "${1:-}" in
  setup) cmd_setup ;;
  addresses) cmd_addresses ;;
  balances) cmd_balances ;;
  copy-password) cmd_copy_password "${2:-}" ;;
  backup) cmd_backup "${2:-}" ;;
  safe) cmd_safe "${2:-plan}" ;;
  token)
    case "${2:-}" in
      plan) cmd_token_plan ;;
      send) cmd_token_send ;;
      *) die "usage: token plan|send" ;;
    esac
    ;;
  move) cmd_move "${2:-plan}" "${3:-}" ;;
  accept) cmd_accept "${2:-plan}" ;;
  backing) cmd_backing "${2:-}" "${3:-}" ;;
  exit) cmd_exit "${2:-}" "${3:-plan}" "${4:-}" ;;
  *) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' && exit 2 ;;
esac
