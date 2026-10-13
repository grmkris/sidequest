# Sourced by launch-kit.sh. The plan and signed transactions are immutable across retries; only receipts are added.
# Default identity is the command line. For a deliberately new, identical payment, Kris selects a new KIT_OPERATION.
KIT_LOCK=
OP_DIR=
OP_REQUEST=
PLAN_CALLS='[]'
PLAN_RESULT='null'

kit_cleanup() {
  [[ -z "$PWDIR" ]] || rm -rf "$PWDIR"
  if [[ -n "$KIT_LOCK" ]]; then rm -f "$KIT_LOCK/pid"; rmdir "$KIT_LOCK"; fi
}
trap kit_cleanup EXIT

journal_save() {
  local file=$1
  (umask 077 && cat >"$file.$$.tmp") && mv "$file.$$.tmp" "$file" \
    || die "cannot persist journal $file; nothing may be published"
}

journal_begin() {
  local args id old plan
  args=$(jq -cn '$ARGS.positional' --args -- "$@")
  OP_REQUEST=$(jq -cn --arg n "$NETWORK" --arg c "$CHAIN" --argjson a "$args" '{network:$n, chain:$c, arguments:$a}')
  id=$(cast keccak "${KIT_OPERATION:-$OP_REQUEST}")
  [[ "$id" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "cannot derive an operation id"
  OP_DIR="$STATE/operations/$id"
  mkdir -p "$OP_DIR"
  chmod 700 "$KIT_HOME" "$STATE" "$STATE/operations" "$OP_DIR"
  # macOS bash has no flock. A local PID lock also permits recovery after this kit process is interrupted.
  if ! mkdir "$STATE/send.lock" 2>/dev/null; then
    old=$(cat "$STATE/send.lock/pid" 2>/dev/null) || die "another kit send is starting"
    [[ "$old" =~ ^[0-9]+$ ]] || die "invalid send lock; reconcile it before continuing"
    kill -0 "$old" 2>/dev/null && die "another kit send is running (pid $old)"
    rm "$STATE/send.lock/pid"
    rmdir "$STATE/send.lock" || die "cannot release the interrupted send lock"
    mkdir "$STATE/send.lock" || die "another kit send took the lock"
  fi
  KIT_LOCK="$STATE/send.lock"
  (umask 077 && printf '%s\n' "$$" >"$KIT_LOCK/pid")
  # Keep a changed backing file from silently becoming a second batch under the same operation.
  if [[ "${1:-}" == backing ]]; then
    [[ -f "${3:-}" ]] || die "usage: backing plan|send <file.json>"
    OP_REQUEST=$(jq --slurpfile rows "$3" '. + {backing: $rows[0]}' <<<"$OP_REQUEST")
  fi
  if [[ -f "$OP_DIR/plan.json" ]]; then
    [[ "$(jq -cS .request "$OP_DIR/plan.json")" == "$(jq -cS . <<<"$OP_REQUEST")" ]] \
      || die "saved operation differs; reconcile its plan before selecting a new KIT_OPERATION"
    execute_plan
    say "Reconciled the saved operation: $OP_DIR/plan.json"
    exit 0
  fi
  for plan in "$STATE"/operations/*/plan.json; do
    [[ ! -f "$plan" || -f "${plan%/plan.json}/complete.json" || -f "${plan%/plan.json}/failed.json" ]] \
      || die "unfinished operation $plan; rerun its original command before starting another"
  done
}

queue_tx() {
  local name=$1 to=$2 value=$3 data from
  shift 3
  from=$(addr "$name")
  data=$(cast calldata "$@") || die "cannot encode the transaction plan"
  PLAN_CALLS=$(jq --arg n "$name" --arg f "$from" --arg t "$to" --arg v "$value" --arg d "$data" \
    '. + [{name:$n, from:$f, to:$t, value:$v, data:$d}]' <<<"$PLAN_CALLS")
}

# A non-null receipt is the authority. Never infer success from a publish response or an advanced sender nonce.
journal_receipt() {
  local file=$1 hash receipt status
  hash=$(jq -r .hash "$file")
  receipt=$(cast receipt --async --rpc-url "$RPC" --json "$hash" 2>/dev/null) || return 1
  [[ "$receipt" != null && -n "$receipt" ]] || return 1
  [[ "$(lower "$(jq -r .transactionHash <<<"$receipt")")" == "$(lower "$hash")" ]] \
    || die "receipt does not match journaled transaction $hash"
  status=$(jq -r .status <<<"$receipt")
  jq --argjson r "$receipt" '. + {receipt:$r}' "$file" | journal_save "$file"
  if [[ "$status" == 0x0 || "$status" == 0 ]]; then
    jq --arg h "$hash" '{hash:$h, receipt:.receipt}' "$file" | journal_save "$OP_DIR/failed.json"
  fi
  [[ "$status" == 0x1 || "$status" == 1 ]] || die "journaled transaction $hash reverted; do not re-sign this operation"
  LAST_HASH=$hash
}

journal_reconcile() {
  local file=$1 from nonce current raw hash
  go_check
  journal_receipt "$file" && return 0
  from=$(jq -r .from "$file")
  nonce=$(jq -r .nonce "$file")
  hash=$(jq -r .hash "$file")
  current=$(cast nonce --rpc-url "$RPC" --block latest "$from") || die "cannot reconcile sender nonce for $hash"
  [[ "$current" =~ ^[0-9]+$ ]] || die "invalid sender nonce for $hash"
  if ((current > nonce)); then
    # Receipt and nonce reads may straddle a block; give the original hash one more read before refusing.
    journal_receipt "$file" && return 0
    die "sender nonce $nonce is spent but $hash has no receipt; another transaction may have used it. Stop and reconcile; never re-sign"
  fi
  raw=$(jq -r .raw "$file")
  [[ "$(lower "$(cast keccak "$raw")")" == "$(lower "$hash")" ]] || die "saved signed bytes do not match $hash"
  go_check
  sync # The signed bytes and their hash must survive an interrupted publish.
  if ! cast publish --rpc-url "$RPC" --json "$raw" >/dev/null; then
    journal_receipt "$file" && return 0
    die "publish answer uncertain for $hash; rerun this operation to reconcile the same signed bytes"
  fi
  journal_receipt "$file" || die "receipt still pending for $hash; rerun this operation, never re-sign"
}

journal_sign() {
  local index=$1 file=$2 name from to value data nonce est raw hash signer
  name=$(jq -r ".calls[$index].name" "$OP_DIR/plan.json")
  from=$(jq -r ".calls[$index].from" "$OP_DIR/plan.json")
  to=$(jq -r ".calls[$index].to" "$OP_DIR/plan.json")
  value=$(jq -r ".calls[$index].value" "$OP_DIR/plan.json")
  data=$(jq -r ".calls[$index].data" "$OP_DIR/plan.json")
  go_check
  unlock "$name"
  signer=$(cast wallet address --keystore "$KEYS/sidequest-$name" --password-file "$PWFILE")
  [[ "$(lower "$signer")" == "$(lower "$from")" ]] || die "keystore does not match the planned sender"
  nonce=$(cast nonce --rpc-url "$RPC" --block pending "$from") || die "cannot read the signing nonce"
  [[ "$nonce" =~ ^[0-9]+$ ]] || die "invalid signing nonce"
  est=$(cast estimate --rpc-url "$RPC" --from "$from" --value "$value" "$to" "$data") || die "the estimate reverted: not signed"
  raw=$(cast mktx --rpc-url "$RPC" --chain "$CHAIN" --nonce "$nonce" \
    --keystore "$KEYS/sidequest-$name" --password-file "$PWFILE" --value "$value" \
    --gas-limit "$(calc "$est * 125 / 100")" "$to" "$data") || die "cannot build the signed transaction"
  [[ "$raw" =~ ^0x[0-9a-fA-F]+$ ]] || die "invalid signed transaction"
  hash=$(cast keccak "$raw")
  jq -n --arg f "$from" --arg n "$nonce" --arg h "$hash" --arg r "$raw" --arg p "$OP_DIR/plan.json" \
    --argjson call "$(jq ".calls[$index]" "$OP_DIR/plan.json")" \
    '{from:$f, nonce:$n, hash:$h, raw:$r, operation:$p, call:$call}' | journal_save "$file"
  rm -rf "$PWDIR"
  PWDIR= PWFILE=
}

execute_plan() {
  local i count file result
  if [[ ! -f "$OP_DIR/plan.json" ]]; then
    jq -n --argjson r "$OP_REQUEST" --argjson c "$PLAN_CALLS" --argjson result "$PLAN_RESULT" \
      '{request:$r, calls:$c, result:$result}' | journal_save "$OP_DIR/plan.json"
  fi
  count=$(jq '.calls | length' "$OP_DIR/plan.json")
  for ((i = 0; i < count; i++)); do
    file="$OP_DIR/tx-$i.json"
    if [[ ! -f "$file" ]]; then journal_sign "$i" "$file"; fi
    journal_reconcile "$file"
    say "confirmed $LAST_HASH"
    link tx "$LAST_HASH"
  done
  result=$(jq .result "$OP_DIR/plan.json")
  if [[ "$result" != null ]]; then
    jq --arg h "$LAST_HASH" '.record + {hash:$h}' <<<"$result" | save "$(jq -r .file <<<"$result")"
  fi
  jq -n --arg h "$LAST_HASH" '{lastHash:$h}' | journal_save "$OP_DIR/complete.json"
}
