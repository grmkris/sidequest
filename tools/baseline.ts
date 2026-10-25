/**
 * The pure half of `bun run lint:gate`: the per-file, per-rule baseline of findings that predate the strict gates
 * (tools/lint-baseline.json), compared with the current findings. The model is ESLint's bulk suppressions: the recorded
 * findings are allowed, any count above them fails, and the baseline only shrinks. tools/lint-baseline.ts collects the
 * findings and reads and writes the file. Node APIs only: Vitest runs under Node.
 */
import { Schema } from 'effect'
import type { Finding, Source } from './report.ts'

const Count = Schema.Int.check(Schema.isGreaterThan(0))

/** Repository-relative file → rule, as the gate prints it (`typescript(no-explicit-any)`) → findings allowed. */
const BaselineSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Count))
export type Baseline = typeof BaselineSchema.Type

/** The text of tools/lint-baseline.json. Fails on anything but files mapping rules to positive integers. */
export const parseBaseline = Schema.decodeUnknownSync(Schema.fromJsonString(BaselineSchema))

/** Code-unit order: the same in every locale, so the file never changes because of who wrote it. */
const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1
  return a > b ? 1 : 0
}

const sortedEntries = <V>(record: Readonly<Record<string, V>>): Array<[string, V]> =>
  Object.entries(record).toSorted(([a], [b]) => byCodeUnit(a, b))

/** The baseline as the file holds it: keys sorted at both levels, two-space JSON, a trailing newline. */
export const serializeBaseline = (baseline: Baseline): string => {
  const sorted = Object.fromEntries(
    sortedEntries(baseline).map(([file, rules]) => [file, Object.fromEntries(sortedEntries(rules))]),
  )
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/** Findings counted per file and rule, in the baseline's shape. */
export const countFindings = (findings: readonly Finding[]): Baseline => {
  const counts: Record<string, Record<string, number>> = {}
  for (const finding of findings) {
    const rules = counts[finding.file] ?? {}
    rules[finding.rule] = (rules[finding.rule] ?? 0) + 1
    counts[finding.file] = rules
  }
  return counts
}

/** A (file, rule) whose findings exceed the baseline; `baseline` is 0 for a new file or rule. */
export interface Increase {
  readonly file: string
  readonly rule: string
  readonly baseline: number
  readonly actual: number
  /** The lines of that rule's findings in that file, ascending; 0 where the tool gives none. */
  readonly lines: readonly number[]
}

/** A baseline entry above the current findings: fixed debt that `--update` removes from the file. */
export interface Stale {
  readonly file: string
  readonly rule: string
  readonly baseline: number
  readonly actual: number
}

export interface Comparison {
  readonly increases: readonly Increase[]
  readonly stale: readonly Stale[]
}

const countOf = (counts: Baseline, file: string, rule: string): number => counts[file]?.[rule] ?? 0

const linesOf = (findings: readonly Finding[], file: string, rule: string): number[] =>
  [
    ...new Set(findings.filter((finding) => finding.file === file && finding.rule === rule).map(({ line }) => line)),
  ].toSorted((a, b) => a - b)

const flatten = (counts: Baseline): Array<readonly [string, string, number]> =>
  sortedEntries(counts).flatMap(([file, rules]) => sortedEntries(rules).map(([rule, n]) => [file, rule, n] as const))

/** Every (file, rule) above its baseline and every baseline entry above the findings, sorted by file, then rule. */
export const compare = (baseline: Baseline, findings: readonly Finding[]): Comparison => {
  const actual = countFindings(findings)
  const increases = flatten(actual)
    .filter(([file, rule, n]) => n > countOf(baseline, file, rule))
    .map(([file, rule, n]) => ({
      file,
      rule,
      baseline: countOf(baseline, file, rule),
      actual: n,
      lines: linesOf(findings, file, rule),
    }))
  const stale = flatten(baseline)
    .filter(([file, rule, n]) => countOf(actual, file, rule) < n)
    .map(([file, rule, n]) => ({ file, rule, baseline: n, actual: countOf(actual, file, rule) }))
  return { increases, stale }
}

export type Update =
  | { readonly written: true; readonly baseline: Baseline }
  | { readonly written: false; readonly increases: readonly Increase[] }

/** Whether a repository-relative file is one of `paths` or inside one of them; every file when `paths` is empty. */
export const inScope = (file: string, paths: readonly string[]): boolean =>
  paths.length === 0 || paths.some((scope) => file === scope || file.startsWith(`${scope}/`))

/**
 * `--update`: each entry lowered to min(baseline, actual), dropping zero counts and empty files. With `paths`, only
 * the entries of those files and directories change, so an agent in a shared checkout records its own fixes and no one
 * else's. Refused, with the increases, when a count in scope is above its baseline: only `--init` raises the baseline.
 */
export const updateBaseline = (
  baseline: Baseline,
  findings: readonly Finding[],
  paths: readonly string[] = [],
): Update => {
  const increases = compare(baseline, findings).increases.filter(({ file }) => inScope(file, paths))
  if (increases.length > 0) return { written: false, increases }
  const actual = countFindings(findings)
  const lowered = flatten(baseline)
    .map(
      ([file, rule, n]) => [file, rule, inScope(file, paths) ? Math.min(n, countOf(actual, file, rule)) : n] as const,
    )
    .filter(([, , n]) => n > 0)
  const next: Record<string, Record<string, number>> = {}
  for (const [file, rule, n] of lowered) next[file] = { ...next[file], [rule]: n }
  return { written: true, baseline: next }
}

/** The gate a rule belongs to, from its prefix: `knip(…)`, `effect(…)`; every other rule is oxlint's. */
export const sourceOfRule = (rule: string): Source => {
  if (rule.startsWith('knip(')) return 'knip'
  return rule.startsWith('effect(') ? 'effect' : 'oxlint'
}

export interface Totals {
  readonly findings: number
  readonly files: number
  readonly bySource: Readonly<Record<Source, number>>
}

export const totals = (baseline: Baseline): Totals => {
  const bySource: Record<Source, number> = { oxlint: 0, effect: 0, knip: 0 }
  for (const [, rule, n] of flatten(baseline)) bySource[sourceOfRule(rule)] += n
  return {
    findings: bySource.oxlint + bySource.effect + bySource.knip,
    files: Object.keys(baseline).length,
    bySource,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// rendering

const where = (lines: readonly number[]): string => {
  const known = lines.filter((line) => line > 0)
  if (known.length === 0) return ''
  return known.length === 1 ? `  (line ${known.join('')})` : `  (lines ${known.join(', ')})`
}

/** One line per increase: file, rule, baseline → actual and the lines of that rule's findings in that file. */
export const renderIncreases = (increases: readonly Increase[]): string[] =>
  increases.map((row) => `  ${row.file}  ${row.rule}  ${row.baseline} → ${row.actual}${where(row.lines)}`)

/** One line per stale entry: file, rule, baseline → actual. */
export const renderStale = (stale: readonly Stale[]): string[] =>
  stale.map((row) => `  ${row.file}  ${row.rule}  ${row.baseline} → ${row.actual}`)

export const renderTotals = ({ findings, files, bySource }: Totals): string =>
  `${findings} findings in ${files} files (oxlint ${bySource.oxlint}, effect ${bySource.effect}, knip ${bySource.knip})`
