# 0032: Type-aware lint runs on tsrs-lint, a pinned release of our tsrs fork

Status: accepted (Kris, 25 Oct 2026: "adopt the patched headless tsrs-lint as the type-aware lint backend; no backwards-compat
shims or silent fallbacks")
Date: 2026-10-25
Amends [0030](0030-effect-diagnostics-on-tsrs.md), which left type-aware lint on oxlint-tsgolint. Tooling only; no runtime change.

## Context

oxlint runs its type-aware rules (`typescript/no-floating-promises`, the `no-unsafe-*` family, `await-thenable` and the rest)
in a helper process it spawns once per run: `oxlint-tsgolint`, a Go program built on typescript-go, found in `node_modules`
or named by `OXLINT_TSGOLINT_PATH`. oxc-project/tsrs PR 624 ports that helper to Rust (`tsrs-lint headless`) on the same
protocol. A spike on 2026-10-25 found it faster with the same findings, but its memory grew with the number of tsconfig
projects: a headless request kept every project's arenas until it ended (a 21 GiB process-tree peak on a 77-project
monorepo, 3× stock). We found and fixed the cause ([oxc-project/tsrs#783](https://github.com/oxc-project/tsrs/issues/783):
one set of allocation regions per project, freed with its program). PR 624 is an open draft and upstream has no headless
release, so a fork publishes the build: [grmkris/tsrs](https://github.com/grmkris/tsrs), branch `lint-pr624-regions`
(PR 624 head `0acc433` plus the fix), tag
[`lint-pr624-0acc433-regions.1`](https://github.com/grmkris/tsrs/releases/tag/lint-pr624-0acc433-regions.1), built by GitHub Actions on
`ubuntu-24.04` (needs glibc 2.34 or newer) and `macos-14`, with a `SHA256SUMS` file. Its frames are byte-identical to a
local build's on the synthetic repro of #783.

The owner's principles for the adoption: standards and clean code; no backwards-compatibility shims and no silent fallbacks.

## Decision

- **The backend is the pinned release binary.** `tools/tsrs-lint.ts` holds the one pin: the tag and the sha256 of each
  release asset (`17fef910b56c…` for linux-x64, `8e10bd8a4861…` for darwin-arm64). It downloads this
  machine's binary into `~/.cache/tsrs-lint/<tag>/tsrs-lint` (`$XDG_CACHE_HOME` honoured) when the cache lacks it,
  verifies the checksum on every use, and gives every oxlint run `OXLINT_TSGOLINT_PATH`: `bun run lint` (`tools/oxlint.ts`), the collectors of `lint:gate` and `lint:report` (`tools/findings.ts`) and `check:files`. CI runs `bun tools/tsrs-lint.ts` after `bun install`, so the download is its own step.
- **No fallback.** `oxlint-tsgolint` is removed from `package.json`. A bare `oxlint` has no backend and fails on its first
  type-aware rule ("Failed to find tsgolint executable"); an unsupported platform (builds exist for linux-x64 and
  darwin-arm64), a failed download or a checksum that differs from the pin fails the run and prints both hashes. Nothing
  retries with another backend, and nothing is installed when the checksum differs.
- **Editors.** `.vscode/settings.json` sets `oxc.path.tsgolint` to the cached binary (`${userHome}/.cache/tsrs-lint/<tag>/tsrs-lint`);
  any gate run creates it. Zed's and Neovim's oxlint servers take `OXLINT_TSGOLINT_PATH` from the environment of the
  shell that starts them, and the committed Zed settings stay on the default. `tools/test/tsrs-lint.test.ts` keeps the
  setting and the pin equal.
- **Moving the pin** (a rebuild, a newer PR head, or upstream's own release): publish the tag, run the parity method
  below against the current backend on `dev`, and commit the new tag and sums with the evidence. Finding sets
  must be identical, or the pin stays.

## Evidence

Parity on sidequest `dev` at `1a562ae7` ([docs/evidence/tsrs-lint-parity-2026-10-25](../evidence/tsrs-lint-parity-2026-10-25/README.md)): the gates' command,
`oxlint -c oxlint.config.ts -f json .`, with the installed oxlint 1.87.0 and oxlint-tsgolint 7.0.2003, then with the
release binary, on the same tree, each inside one `heavy` slot on the build box while other agents' gates ran (load
average about 20). Finding sets compared as `(rule, file, line, column)`:

| Backend | Wall, s | CPU, s | getrusage peak, GiB | Process-tree peak, GiB | Load at start | Files | Findings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| oxlint-tsgolint (stock) | 23.1 | 73 | 2.99 | 4.21 | 21 | 1321 | 2666 |
| tsrs-lint (pinned release) | 30.4 | 42 | 1.46 | 2.12 | 20 | 1321 | 2666 |

The sets are identical. tsrs-lint used 42% less CPU and the process tree peaked 50% lower; wall time on the shared
box tracks its load more than the backend (the quiet-box spike of the same day measured goblin 45% faster and myapps
equal). Upstream's conformance suite (7,601 tsgolint cases for the 60 rules) and the lifecycle tests pass on the patched
build.

## Consequences

- We maintain the fork release until upstream ships an equivalent headless release (watch
  [tsrs#624](https://github.com/oxc-project/tsrs/pull/624), [#378](https://github.com/oxc-project/tsrs/issues/378) and
  [#783](https://github.com/oxc-project/tsrs/issues/783)); then the pin moves to upstream's asset and the fork goes away.
- Rule behaviour is PR 624's port of tsgolint. Upstream documents history-dependent diagnostics (one checker per lint
  worker); parity showed none.
- `--fix` for type-aware rules now comes from the new backend. The gates never run `--fix`, and fix equivalence is untested.
- A fresh checkout needs GitHub once per tag. A machine without network puts the verified binary at the cache path itself.
- Supersedes the sentence in ADR 0030 that kept type-aware lint on oxlint-tsgolint.
