#!/usr/bin/env bash
# The launch lock (script/launch-lock.sh, the G1-DRY-001 residual), with no chain, no keys and no fork:
#   1. while one run holds it, each fork rehearsal, started separately, refuses at once: exit 1, the refusal its only
#      output, nothing written under config/, broadcast/ or cache/;
#   2. once that run ends, the lock is free.
# Refuses with exit 75 while a real launch or rehearsal holds the lock in this checkout (retry once it ends).
#   bash script/test-launch-lock.sh
set -euo pipefail
{ # parsed whole before it runs, so an edit to this file mid-run cannot change what runs
cd "$(dirname "$0")/.."
. script/launch-lock.sh
SCRIPTS=(rehearse-launch.sh rehearse-sidequest-pipeline.sh)
REFUSAL="refusing: another launch or rehearsal is running in this checkout (it holds $LAUNCH_LOCK)"
# Each script runs as an unrelated process would: fd 9 closed, no colour, and (should one ever not refuse) no reachable
# RPC to fork or send to.
CLEAN=(env -u FORCE_COLOR -u FOUNDRY_BROADCAST -u FOUNDRY_CACHE_PATH NO_COLOR=1 RPC=http://127.0.0.1:9
  MAINNET_RPC=http://127.0.0.1:9 RPC_ENV=LAUNCH_LOCK_TEST_NO_RPC)
HOLDER=
trap '[[ -z "$HOLDER" ]] || kill "$HOLDER" 2>/dev/null || true' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
free() { flock -n "$LAUNCH_LOCK" true 9>&-; }
listing() { ls -A config broadcast cache 2>/dev/null || true; }
run() { set +e; OUT=$("$@" 2>&1 9>&-); CODE=$?; set -e; }

free || { echo "a launch or rehearsal is running in this checkout; retry once it ends" >&2; exit 75; }

# 1. A run in progress: take_launch_lock, then wait (exec keeps fd 9, and with it the lock).
bash -c '. script/launch-lock.sh && take_launch_lock && exec sleep 300' 9>&- &
HOLDER=$!
for _ in $(seq 50); do free || break; sleep 0.1; done
! free || fail "the holder did not take the lock"
before=$(listing)
for s in "${SCRIPTS[@]}"; do
  run "${CLEAN[@]}" bash "script/$s"
  [[ $CODE -eq 1 && "$OUT" == "$REFUSAL" ]] || fail "$s, started while another run held the lock, did not refuse at once (exit $CODE): $OUT"
done
[[ "$(listing)" == "$before" ]] || fail "a refused run wrote under config/, broadcast/ or cache/"
ok "while one run holds the lock, ${SCRIPTS[*]} each refuse at once (exit 1, nothing written)"

# 2. It ends; the lock is free.
kill "$HOLDER"; wait "$HOLDER" 2>/dev/null || true; HOLDER=
for _ in $(seq 50); do free && break; sleep 0.1; done
free || fail "the lock is still held after its run ended"
ok "once that run ends, the lock is free"

echo "LAUNCH LOCK TEST PASSED"
exit
}
