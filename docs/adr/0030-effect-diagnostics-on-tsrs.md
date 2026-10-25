# 0030: Effect diagnostics on tsrs

Status: accepted (Kris, 24 Oct 2026: adopt tsrs and `@yielded/effect-tsrs` in every repository; the 25 October
overnight plan brought them here after goblin's ADR 0120). Changes how `bun run typecheck` and `bun run lint:gate` run;
no runtime change.
Date: 2026-10-25

**Amended (25 Oct 2026): the fallback is removed, and effect-tsrs moves to 0.2.2.** Kris: "if we're at the same
parity, the `EFFECT_CHECKER=tsgo` fallback can be dropped." Parity held, so `typecheck` and the Effect source run
effect-tsrs only; `EFFECT_CHECKER` is no longer read or hashed by turbo, and nothing in the gates runs tsc or
effect-tsgo. The pin is 0.2.2 (same tsrs rev 8f135f1), after the same parity method reran identical on all 13 projects
([evidence](../evidence/tsrs-parity-2026-10-25/README.md), "Rerun on effect-tsrs 0.2.2"). 0.2.2 needs `--type-check` for
the TypeScript diagnostics, which both passes now pass, and reports Effect diagnostics only on a project's own files, so
the "only files some typecheck tsconfig includes" rule below now holds by itself and its `tsc --showConfig` filter is
gone. `typescript` and `@effect/tsgo` stay installed for editors. `check` still compiles each project twice
(`typecheck`, then the Effect source): turbo's `test` tasks depend on `^typecheck`, and the baseline is judged across
all projects at once, so folding the two would mean caching each project's Effect findings as a turbo output for
`lint:gate` to read; not done. Revert the commits `tools: the EFFECT_CHECKER=tsgo fallback is gone …` and `tools:
effect-tsrs 0.2.2 …` to restore the fallback.

## Context

`bun run typecheck` ran tsc (TypeScript 7.0.2, the Go compiler) on the 13 tsconfigs the gates cover: `scripts/ci`,
`crew` and every workspace with a `typecheck` script. Sidequest had no Effect diagnostics at all, although its API,
board and SDK are Effect 4 programs. tsrs (oxc-project/tsrs) is a Rust port of the TypeScript 7 compiler, and
`@yielded/effect-tsrs` (MIT) runs all of Effect's language-service diagnostics on it, reading the
`@effect/language-service` block of the tsconfig.

## Decision

- **`typecheck` runs on tsrs.** `tools/typecheck.ts` runs `effect-tsrs diagnostics --rules none` (the compiler alone)
  once per tsconfig and fails on a TypeScript error. Root `typecheck` runs it on `scripts/ci` and `crew`, then every
  workspace through turbo; `check:files` runs it on the root tsconfig for root files.
- **The Effect diagnostics join `lint:gate`** as a third source beside oxlint and knip (`tools/findings.ts`): effect-tsrs
  with every rule on each typecheck project, each finding counted once as `effect(<name>)`, judged against
  `tools/lint-baseline.json`. Errors, warnings and directives that change nothing count; messages and suggestions stay
  editor advice. Only files some typecheck tsconfig includes count (effect-tsrs also reports files a project merely
  imports, effect-tsgo does not; the baseline holds under either). A project whose tsconfig neither sets nor inherits
  the plugin block, or whose run has TypeScript errors, fails the collection.
- **Severities are goblin's** (tsconfig.base.json): the structural diagnostics are errors, global APIs are errors inside
  Effect code, `processEnv` and `nodeBuiltinImport` are errors outside tests, configs, `.tsx` views and the operator
  scripts, tools and crew CLI.
- **The 180 existing findings are baselined**, so the gate passed from day one and only shrinks
  ([evidence](../evidence/tsrs-parity-2026-10-25/README.md) lists them by rule; `processEnv` is half of them).
- **Pins are exact** (catalog): `@yielded/effect-tsrs` 0.2.0 (bundles tsrs rev 8f135f1, TypeScript 7.1-dev), run as
  its native binary; `@effect/tsgo` 0.54.0 for editors and the fallback.
- **`EFFECT_CHECKER=tsgo` falls back** for about two weeks (until 2026-11-08): tsc for `typecheck`, effect-tsgo for the
  Effect source. Turbo hashes the variable on every typecheck task.

## Evidence

On every project, effect-tsrs and tsc report the same TypeScript diagnostics (none on the tree), and effect-tsrs and
effect-tsgo the same Effect diagnostics; three runs were byte-identical. tsc took 81 s summed at up to 1.45 GB;
`--rules none` takes 32 s and the full pass 38 s, at up to 0.5 GB.

## Consequences

- `check` runs the compiler twice per project (`typecheck`, then the Effect source), both on tsrs, together cheaper
  than tsc alone was. Folding them into one pass needs the Effect findings judged per project against the baseline;
  a follow-up.
- Shrinking the Effect baseline: `processEnv` reads belong in Effect `Config` or the stage env files;
  `extendsNativeError` classes become tagged errors.
- tsrs follows TypeScript 7.1-dev while editors and the fallback run 7.0.2; the fallback is the escape hatch while
  effect-tsrs is new.
