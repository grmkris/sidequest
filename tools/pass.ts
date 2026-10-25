/**
 * One project's passes (ADR 0030, ported from goblin's tools/pass.ts). `bun run typecheck` (tools/typecheck.ts) runs the
 * TypeScript pass: effect-tsrs with `--rules none`, the compiler alone. The Effect collector of `lint:gate`
 * (tools/findings.ts) runs the Effect pass: effect-tsrs with every rule, judged against tools/lint-baseline.json. Commands run from the repository root without `heavy`: run the whole task through
 * it.
 */
import path from 'node:path'
import { effectArgs, missingPlugin, verifiedEffectOutput } from './effect.ts'
import { decodeEffect, typescriptErrors, uncheckedFiles } from './report.ts'
import type { EffectOutput } from './report.ts'
import { repoRoot, run } from './run.ts'

/** effect-tsrs exits 1 when it reports errors; anything else non-zero means it did not run. */
const FOUND = 1

export interface Pass {
  /** The tsconfig, repository-relative. */
  readonly label: string
  /** Why the pass cannot be trusted: a checker that did not run, or a tsconfig whose files skip the Effect diagnostics. */
  readonly failures: readonly string[]
  /** TypeScript errors as tsc prints them, one entry each. */
  readonly typescript: readonly string[]
  /** The Effect diagnostics, directive-checked; undefined for the TypeScript pass and when the checker did not run. */
  readonly effect: EffectOutput | undefined
}

const labelOf = (project: string): string => path.relative(repoRoot, project)

/** One effect-tsrs run, decoded. */
const checked = async (project: string, rules: 'all' | 'none'): Promise<Pass> => {
  const label = labelOf(project)
  const result = await run(effectArgs(project, rules))
  if (result.exitCode !== 0 && result.exitCode !== FOUND) {
    const failure = `${label}: effect-tsrs exited ${result.exitCode}\n${result.stderr.trim()}`
    return { label, failures: [failure], typescript: [], effect: undefined }
  }
  const effect = verifiedEffectOutput(decodeEffect(JSON.parse(result.stdout)))
  return { label, failures: [], typescript: typescriptErrors(effect), effect }
}

/** The TypeScript diagnostics of `tsconfig` (repository-relative or absolute): the compiler alone. */
export const typescriptPass = async (tsconfig: string): Promise<Pass> => {
  const result = await checked(path.resolve(repoRoot, tsconfig), 'none')
  return { ...result, effect: undefined }
}

/**
 * The Effect diagnostics of `tsconfig`. Its tsconfig must set or inherit the plugin block; effect-tsrs reports the
 * project's TypeScript errors in the same run.
 */
export const effectPass = async (tsconfig: string): Promise<Pass> => {
  const project = path.resolve(repoRoot, tsconfig)
  const missing = missingPlugin(project)
  const result = await checked(project, 'all')
  const unchecked = result.effect === undefined ? undefined : uncheckedFiles(result.label, result.effect)
  return {
    ...result,
    failures: [
      ...(missing === undefined ? [] : [missing]),
      ...result.failures,
      ...(unchecked === undefined ? [] : [unchecked]),
    ],
  }
}
