# tsrs-lint parity, 2026-10-25 (ADR 0032)

Before the type-aware lint backend moved to the pinned tsrs-lint release (`lint-pr624-0acc433-regions.1`), the gates' oxlint run was measured
twice on sidequest `dev` at `1a562ae7`, same tree, one command at a time inside one `heavy` slot on the build box:
once with the installed oxlint-tsgolint 7.0.2003 (oxlint 1.87.0), once with `OXLINT_TSGOLINT_PATH` naming the release
binary (sha256 `17fef910b56c1638a9429e2c6e5f22dd89591234821687dc443d116be63832a5`).

## Method

- Command: `node_modules/.bin/oxlint -c oxlint.config.ts -f json .` from the repository root, the configuration the gates use.
- `measure.py` (the spike's, `~/spikes/tsrslint-20261025/scripts/measure.py`) runs the command in a fresh Python process and records wall time,
  the children's CPU seconds, `getrusage(RUSAGE_CHILDREN)` peak RSS and the peak RSS of the whole process tree sampled
  every 100 ms (`stock.metrics.json`, `pinned.metrics.json`).
- `compare.py` normalizes each run's diagnostics to the set `(rule, file, line, column)`, with files relative to the
  repository root, and lists what only one side reports (`compare.json`).
- Other agents' gates were running: the load average at the start of each run is in the table. Memory does not depend on
  it; wall time does.

## Results

| Backend | Wall, s | CPU, s | getrusage peak, GiB | Process-tree peak, GiB | Load at start | Files | Findings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| oxlint-tsgolint (stock) | 23.1 | 73 | 2.99 | 4.21 | 21 | 1321 | 2666 |
| tsrs-lint (pinned release) | 30.4 | 42 | 1.46 | 2.12 | 20 | 1321 | 2666 |

Sets identical: **yes** (2666 findings on both sides, none on one side only).

The release binary's headless frames are byte-identical to the local build's on the synthetic repro of tsrs#783
(40 projects × 24 files, 960 frames); the spike measured raw helper frames byte-identical to PR 624 head's on this
repository's own request as well (`~/spikes/tsrslint-20261025/evidence/fix/`).
