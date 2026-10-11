# Sourced by the fork rehearsals (rehearse-launch.sh, rehearse-sidequest-pipeline.sh). A real launch run from the same checkout writes config/<network>.json and forge's
# broadcast/<script>/<chain>/run-latest.json (with its cache/ twin); a rehearsal must never write or delete either
# (G1-DRY-001 and its residual).

# rehearsal_run: this run's own names and forge paths. RUN_ID is the pid plus 32 random bits. NETWORK=rehearsal-$RUN_ID
# selects the scratch config/rehearsal-$RUN_ID.json (gitignored). Forge writes this run's broadcast logs and their cache
# twins under broadcast/rehearsal-$RUN_ID and cache/rehearsal-$RUN_ID (FOUNDRY_BROADCAST, FOUNDRY_CACHE_PATH), and the
# scripts read them back from there (script/BroadcastPath.sol), so a rehearsal never touches a real launch's logs. Both
# directories are new, marked with RUN_ID; the compile cache is seeded from the shared one, so nothing recompiles.
rehearsal_run() {
  local d
  RUN_ID="$$-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
  export NETWORK="rehearsal-$RUN_ID" FOUNDRY_BROADCAST="broadcast/rehearsal-$RUN_ID" FOUNDRY_CACHE_PATH="cache/rehearsal-$RUN_ID"
  for d in "$FOUNDRY_BROADCAST" "$FOUNDRY_CACHE_PATH"; do
    mkdir -p "$(dirname "$d")"
    mkdir "$d" || { echo "refusing: $d already exists" >&2; exit 1; }
    printf '%s\n' "$RUN_ID" >"$d/.rehearsal-run"
  done
  if [[ -e cache/solidity-files-cache.json ]]; then cp cache/solidity-files-cache.json "$FOUNDRY_CACHE_PATH/"; fi
}

# real_logs <chain>: a digest of every forge log for <chain> outside the rehearsal directories: a real launch's
# broadcast/<script>/<chain>/run-latest.json and the rest, with their cache/ twins. A rehearsal takes it after
# rehearsal_run and checks it again before it passes, to show it touched none of them.
real_logs() {
  { find broadcast cache -path '*/rehearsal-*' -prune -o -path "*/$1/*" -type f -print 2>/dev/null || true; } \
    | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum
}

# owned_run_dirs: on exit, deletes this run's two forge directories, each only if it still carries this run's mark.
owned_run_dirs() {
  local d
  for d in "${FOUNDRY_BROADCAST:-}" "${FOUNDRY_CACHE_PATH:-}"; do
    [[ -n "${RUN_ID:-}" && "$d" == */rehearsal-"$RUN_ID" && -d "$d" ]] || continue
    if [[ "$(cat "$d/.rehearsal-run" 2>/dev/null)" == "$RUN_ID" ]]; then rm -rf -- "$d"; else echo "kept $d: not this rehearsal's" >&2; fi
  done
}

# owned_file <path> <jq path> <value>: deletes <path> only if <jq path> in it is <value> (addresses compared in lower
# case), e.g. a scratch config or a candidate naming this run's Safe.
owned_file() {
  [[ -e "$1" ]] || return 0
  if [[ -n "$3" && "$(jq -r "$2" "$1" 2>/dev/null | tr 'A-F' 'a-f')" == "$(tr 'A-F' 'a-f' <<<"$3")" ]]; then
    rm -f "$1"
  else
    echo "kept $1: its $2 is not this rehearsal's" >&2
  fi
}
