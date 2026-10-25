# tsrs parity, 2026-10-25 (ADR 0030)

Before `bun run typecheck` moved onto tsrs and `lint:gate` gained the Effect diagnostics, every project the typecheck
covers ran under tsc 7.0.2 and effect-tsgo 0.54.0 (`@effect/tsgo`) and under `@yielded/effect-tsrs` 0.2.0 (bundled tsrs
rev 8f135f1, TypeScript 7.1-dev), with the plugin block of tsconfig.base.json in place, on `dev` at 392bd7af. The method
and scripts are goblin's (`evidence/tsrs-parity-20261025/` in grmkris/goblin, its ADR 0120): each command alone, from the
repository root, through `heavy`, wall time and peak RSS from `resource.getrusage(RUSAGE_CHILDREN)` in a fresh process
per command; Effect diagnostics compared as `(file, line, code, severity)` sets over each project's own files, TypeScript
diagnostics as `(file, line, code)` sets, three effect-tsrs runs compared byte for byte.

| Project | Own files | tsc | effect-tsgo | effect-tsrs, 3 runs | `--rules none` | Effect diagnostics / counted | Effect equal | TS equal | Deterministic |
| :-- | --: | --: | --: | --: | --: | --: | :-- | :-- | :-- |
| `scripts/ci/tsconfig.json` | 3 | 1.61 s, 307 MB | 1.9 s | 0.87 / 0.68 / 0.68 s, 131 MB | 0.58 s | 4 / 4 | yes | yes | yes |
| `crew/tsconfig.json` | 27 | 2.97 s, 555 MB | 2.17 s | 1.48 / 1.62 / 1.48 s, 175 MB | 1.03 s | 41 / 31 | yes | yes | yes |
| `apps/api/tsconfig.json` | 245 | 8.95 s, 1207 MB | 14.75 s | 6.68 / 5.85 / 4.66 s, 431 MB | 3.24 s | 103 / 63 | yes | yes | yes |
| `apps/arbiter/tsconfig.json` | 22 | 4.01 s, 609 MB | 3.19 s | 1.63 / 1.79 / 1.93 s, 186 MB | 1.64 s | 27 / 14 | yes | yes | yes |
| `apps/docs/tsconfig.json` | 39 | 1.94 s, 335 MB | 2.24 s | 0.99 / 0.9 / 0.86 s, 119 MB | 1.08 s | 2 / 2 | yes | yes | yes |
| `apps/explore/tsconfig.json` | 471 | 15.71 s, 1454 MB | 15.83 s | 7.36 / 6.7 / 7.29 s, 497 MB | 4.08 s | 12 / 6 | yes | yes | yes |
| `apps/indexer/tsconfig.json` | 3 | 7.39 s, 938 MB | 4.87 s | 2.76 / 2.55 / 2.47 s, 358 MB | 3.04 s | 12 / 12 | yes | yes | yes |
| `packages/board/tsconfig.json` | 135 | 9.95 s, 1196 MB | 11.17 s | 4.96 / 5.09 / 4.51 s, 407 MB | 3.37 s | 7 / 7 | yes | yes | yes |
| `packages/commons/tsconfig.json` | 58 | 1.76 s, 263 MB | 3.74 s | 1.42 / 1.1 / 1.86 s, 95 MB | 2.29 s | 27 / 1 | yes | yes | yes |
| `packages/indexer/tsconfig.json` | 34 | 9.02 s, 933 MB | 6.28 s | 3.59 / 6.08 / 4.99 s, 356 MB | 7.13 s | 4 / 4 | yes | yes | yes |
| `packages/react/tsconfig.json` | 13 | 10.19 s, 485 MB | 4.46 s | 1.63 / 1.66 / 1.67 s, 182 MB | 1.59 s | 2 / 2 | yes | yes | yes |
| `packages/sdk/tsconfig.json` | 164 | 6.33 s, 697 MB | 11.03 s | 4.25 / 3.25 / 3.47 s, 204 MB | 2.42 s | 34 / 34 | yes | yes | yes |
| `tools/tsconfig.json` | 23 | 1.53 s, 202 MB | 2.47 s | 0.69 / 0.66 / 1.05 s, 79 MB | 0.64 s | 2 / 0 | yes | yes | yes |
| **Sum / peak** | | **81.4 s, 1454 MB** | **84.1 s** | **38.3 s, 497 MB** | **32.1 s** | **277 / 180** | | | |

- Every set is identical; neither checker reported a TypeScript error. Goblin's seeded run (28 type errors in five
  projects) showed tsc and effect-tsrs agree error for error.
- `typecheck` now runs `--rules none` (the compiler alone): 32.1 s summed against tsc's 81.4 s.
- effect-tsrs also reports Effect diagnostics on files a project imports from elsewhere; effect-tsgo reports only the
  tsconfig's own files. `lint:gate` counts a finding only in a file some typecheck tsconfig includes (`tsc
  --showConfig`), and each once (by file, line and rule), so both checkers give the same 180 findings in 95 (file, rule)
  entries. One finding only effect-tsrs saw, `processEnv` in `infra/stage.ts` (imported by `alchemy.run.ts`, included by
  no tsconfig), is left out by that rule. The 180 went into `tools/lint-baseline.json`: `processEnv` 90,
  `extendsNativeError` 29, `nodeBuiltinImport` 16, `globalDateInEffect` 15, `cryptoRandomUUIDInEffect` 11,
  `schemaSyncInEffect` 10, `globalTimersInEffect` 2, `multipleEffectProvide` 2, and one each of `processEnvInEffect`,
  `globalConsoleInEffect`, `tryCatchInEffectGen`, `globalRandomInEffect` and `globalFetchInEffect`. No existing entry
  changed.

`parity.json` holds every number and set difference (all empty).

## Rerun on effect-tsrs 0.2.2 (ADR 0030, amended 25 Oct)

Before the pin moved from 0.2.0 to 0.2.2 (still tsrs rev 8f135f1), the same method ran again on every project, on `dev`
at 1e5f874a (the `tools` project already without the fallback) against tsc 7.0.2 and effect-tsgo 0.54.0. 0.2.2 reports the TypeScript diagnostics only with `--type-check`,
so effect-tsrs ran through a wrapper that appends that flag. Results: `parity-0.2.2.json`, `seeded-0.2.2.json`.

| Project | Own files | tsc | effect-tsgo | effect-tsrs 0.2.2, 3 runs | Effect diagnostics / gating | Effect equal | TS equal (errors) | Deterministic |
| :-- | --: | --: | --: | --: | --: | :-- | :-- | :-- |
| `scripts/ci/tsconfig.json` | 3 | 2.5 s, 308 MB | 2.47 s, 271 MB | 0.83 / 0.98 / 0.97 s, 129 MB | 4 / 4 | yes | yes (0) | yes |
| `crew/tsconfig.json` | 27 | 4.72 s, 517 MB | 2.65 s, 360 MB | 1.52 / 1.48 / 1.64 s, 177 MB | 41 / 31 | yes | yes (0) | yes |
| `apps/api/tsconfig.json` | 245 | 8.97 s, 1180 MB | 8.36 s, 1187 MB | 4.51 / 5.03 / 5.21 s, 432 MB | 103 / 63 | yes | yes (0) | yes |
| `apps/arbiter/tsconfig.json` | 22 | 4.73 s, 592 MB | 2.88 s, 425 MB | 1.87 / 1.6 / 1.72 s, 190 MB | 27 / 14 | yes | yes (0) | yes |
| `apps/docs/tsconfig.json` | 39 | 1.85 s, 348 MB | 2.13 s, 295 MB | 0.85 / 0.88 / 0.9 s, 116 MB | 2 / 2 | yes | yes (0) | yes |
| `apps/explore/tsconfig.json` | 471 | 10.67 s, 1417 MB | 11.56 s, 1559 MB | 6.05 / 4.97 / 4.7 s, 494 MB | 12 / 6 | yes | yes (0) | yes |
| `apps/indexer/tsconfig.json` | 3 | 5.07 s, 939 MB | 3.26 s, 688 MB | 2.04 / 1.91 / 1.98 s, 360 MB | 12 / 12 | yes | yes (0) | yes |
| `packages/board/tsconfig.json` | 135 | 7.06 s, 1112 MB | 7.34 s, 1015 MB | 3.64 / 3.29 / 3.55 s, 409 MB | 7 / 7 | yes | yes (0) | yes |
| `packages/commons/tsconfig.json` | 58 | 1.4 s, 257 MB | 2.33 s, 268 MB | 0.63 / 0.57 / 0.66 s, 96 MB | 27 / 1 | yes | yes (0) | yes |
| `packages/indexer/tsconfig.json` | 34 | 5.24 s, 919 MB | 3.87 s, 775 MB | 2.41 / 2.21 / 2.27 s, 356 MB | 4 / 4 | yes | yes (0) | yes |
| `packages/react/tsconfig.json` | 13 | 3.47 s, 484 MB | 2.5 s, 395 MB | 1.5 / 1.46 / 1.27 s, 184 MB | 2 / 2 | yes | yes (0) | yes |
| `packages/sdk/tsconfig.json` | 164 | 4.4 s, 692 MB | 5.5 s, 772 MB | 2.05 / 2.26 / 2.65 s, 206 MB | 34 / 34 | yes | yes (0) | yes |
| `tools/tsconfig.json` | 28 | 0.72 s, 205 MB | 1.71 s, 211 MB | 0.45 / 0.4 / 0.4 s, 82 MB | 9 / 1 | yes | yes (0) | yes |
| **Sum / peak** | | **60.8 s, 1417 MB** | **56.6 s, 1559 MB** | **28.3 s, 494 MB** | **284 / 181** | | | |

- Every set is identical, and the three runs per project were byte-identical. Neither checker reported a TypeScript
  error on the tree.
- 0.2.2 reports Effect diagnostics only on a project's own files, as effect-tsgo does: on every project the full set
  equals the own-file set, so the `tsc --showConfig` filter `lint:gate` needed for 0.2.0 (`infra/stage.ts`) is gone.
- Seeded type errors (goblin's seed files placed in `tools/`, `packages/commons/src/` and `apps/explore/src/`): tsc and
  effect-tsrs reported the same 14 errors at the same positions with the same codes, both with `--type-check` and with
  `--type-check --rules none` (what `typecheck` runs); one message differs only in how a long type is elided. Both exit
  1.
- tsconfig.base.json sets `singleThreaded: true`, which 0.2.2 honours, so each pass still runs on one thread.
