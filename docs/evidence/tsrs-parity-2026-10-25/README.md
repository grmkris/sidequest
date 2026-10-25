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
