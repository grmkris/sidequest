/**
 * One project's passes (ADR 0030, ported from goblin's tools/pass.ts). `bun run typecheck` (tools/typecheck.ts) runs the
 * TypeScript pass: effect-tsrs with `--rules none`, the compiler alone, or with `EFFECT_CHECKER=tsgo` tsc. The Effect
 * collector of `lint:gate` (tools/findings.ts) runs the Effect pass: effect-tsrs with every rule, or effect-tsgo, judged
 * against tools/lint-baseline.json. Commands run from the repository root without `heavy`: run the whole task through
 * it.
 */
import { Schema } from 'effect'
import path from 'node:path'
import { effectArgs, missingPlugin, verifiedEffectOutput } from './effect.ts'
import type { Checker } from './effect.ts'
import { decodeEffect, typescriptErrors, uncheckedFiles } from './report.ts'
import type { EffectOutput } from './report.ts'
import { bin, repoRoot, run } from './run.ts'

/** effect-tsrs and effect-tsgo exit 1 when they report errors; anything else non-zero means they did not run. */
const FOUND = 1

export interface Pass {
  /** The tsconfig, repository-relative. */
  readonly label: string
  /** Why the pass cannot be trusted: a checker that did not run, or a tsconfig whose files skip the Effect diagnostics. */
  readonly failures: readonly string[]
  /** TypeScript errors as tsc prints them, one entry each; effect-tsgo reports none. */
  readonly typescript: readonly string[]
  /** The Effect diagnostics, directive-checked; undefined for the TypeScript pass and when the checker did not run. */
  readonly effect: EffectOutput | undefined
}

const labelOf = (project: string): string => path.relative(repoRoot, project)

/** tsc's errors on one project: its output, one entry per diagnostic (an indented line continues the one above). */
const tsc = async (project: string): Promise<Pass> => {
  const result = await run([bin('tsc'), '-p', project, '--pretty', 'false'])
  const errors: string[] = []
  for (const line of result.stdout.split('\n').filter((text) => text.trim() !== '')) {
    if (/^\s/u.test(line) && errors.length > 0) errors[errors.length - 1] += `\n${line}`
    else errors.push(line)
  }
  const label = labelOf(project)
  const failures =
    result.exitCode !== 0 && errors.length === 0
      ? [`${label}: tsc exited ${result.exitCode}\n${result.stderr.trim()}`]
      : []
  return { label, failures, typescript: errors, effect: undefined }
}

/** One effect-tsrs or effect-tsgo run, decoded. */
const checked = async (project: string, using: Checker, rules: 'all' | 'none'): Promise<Pass> => {
  const label = labelOf(project)
  const result = await run(effectArgs(project, using, rules))
  if (result.exitCode !== 0 && result.exitCode !== FOUND) {
    const failure = `${label}: effect-${using} exited ${result.exitCode}\n${result.stderr.trim()}`
    return { label, failures: [failure], typescript: [], effect: undefined }
  }
  const effect = verifiedEffectOutput(decodeEffect(JSON.parse(result.stdout)))
  return { label, failures: [], typescript: typescriptErrors(effect), effect }
}

/** The TypeScript diagnostics of `tsconfig` (repository-relative or absolute): the compiler alone. */
export const typescriptPass = async (tsconfig: string, using: Checker): Promise<Pass> => {
  const project = path.resolve(repoRoot, tsconfig)
  if (using === 'tsgo') return tsc(project)
  const result = await checked(project, using, 'none')
  return { ...result, effect: undefined }
}

/**
 * The Effect diagnostics of `tsconfig`. Its tsconfig must set or inherit the plugin block; effect-tsrs reports the
 * project's TypeScript errors in the same run.
 */
export const effectPass = async (tsconfig: string, using: Checker): Promise<Pass> => {
  const project = path.resolve(repoRoot, tsconfig)
  const missing = missingPlugin(project)
  const result = await checked(project, using, 'all')
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

const ShowConfig = Schema.Struct({ files: Schema.optional(Schema.Array(Schema.String)) })
const decodeShowConfig = Schema.decodeUnknownSync(ShowConfig)

/**
 * The files a tsconfig itself includes, repository-relative, as `tsc --showConfig` lists them (configuration only, no
 * type check). effect-tsrs also reports files a project merely imports; effect-tsgo does not.
 */
export const ownFiles = async (
  tsconfig: string,
): Promise<{ files: readonly string[]; failures: readonly string[] }> => {
  const project = path.resolve(repoRoot, tsconfig)
  const result = await run([bin('tsc'), '-p', project, '--showConfig'])
  if (result.exitCode !== 0) {
    return {
      files: [],
      failures: [`${labelOf(project)}: tsc --showConfig exited ${result.exitCode}\n${result.stderr.trim()}`],
    }
  }
  const files = decodeShowConfig(JSON.parse(result.stdout)).files ?? []
  return {
    files: files.map((file) =>
      labelOf(path.resolve(path.dirname(project), file))
        .split(path.sep)
        .join('/'),
    ),
    failures: [],
  }
}
