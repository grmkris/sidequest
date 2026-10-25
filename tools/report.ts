/**
 * The pure half of `bun run lint:report`: findings from every gate, attributed to the workspace that owns the file
 * (tools/graph.ts), counted per rule and per workspace, and rendered as Markdown or JSON. tools/lint-report.ts runs the
 * gates and feeds this module.
 */
import { Schema } from 'effect'
import path from 'node:path'
import { nodes } from './graph.ts'
import { repoRoot } from './run.ts'

/** Which gate reported a finding. Each new gate adds its own source. */
export type Source = 'oxlint' | 'effect' | 'knip'

export interface Finding {
  readonly source: Source
  /** As the gate prints it, for example `typescript(no-explicit-any)`. */
  readonly rule: string
  /** Repository-relative, `/`-separated. */
  readonly file: string
  readonly line: number
  /** The rule has a safe automatic fix (`oxlint --fix` applies it where it can). */
  readonly fixable: boolean
}

export const ROOT_WORKSPACE = '(root)'
const byLongestDir = nodes.toSorted((a, b) => b.dir.length - a.dir.length)

/** The workspace directory that owns a repository-relative file, or `(root)` for files outside every workspace. */
export const workspaceOf = (file: string): string =>
  byLongestDir.find((node) => file.startsWith(`${node.dir}/`))?.dir ?? ROOT_WORKSPACE

// ---------------------------------------------------------------------------------------------------------------------
// oxlint

const OxlintOutput = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      // Absent on diagnostics that belong to no rule, such as an unused disable directive.
      code: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      filename: Schema.String,
      labels: Schema.optional(
        Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.optional(Schema.Number) }) })),
      ),
    }),
  ),
})
const decodeOxlint = Schema.decodeUnknownSync(OxlintOutput)

/** The rule a diagnostic belongs to; directives and other rule-less diagnostics get a stable name of their own. */
const ruleOf = (diagnostic: { readonly code?: string | undefined; readonly message?: string | undefined }): string => {
  if (diagnostic.code !== undefined) return diagnostic.code
  return diagnostic.message?.startsWith('Unused ') === true ? 'oxlint(unused-disable-directive)' : 'oxlint(other)'
}

/** `oxlint -f json` output as findings. `fixable` answers for a rule code such as `eslint(no-unused-vars)`. */
export const fromOxlint = (output: unknown, fixable: (code: string) => boolean): Finding[] =>
  decodeOxlint(output).diagnostics.map((diagnostic) => ({
    source: 'oxlint',
    rule: ruleOf(diagnostic),
    file: diagnostic.filename.split('\\').join('/'),
    line: diagnostic.labels?.[0]?.span.line ?? 0,
    fixable: fixable(ruleOf(diagnostic)),
  }))

/** Fix kinds `oxlint --rules -f json` reports for rules whose fix `oxlint --fix` applies. */
const SAFE_FIX_KINDS = new Set([
  'fixable_fix',
  'conditional_fix',
  'fixable_safe_fix_or_suggestion',
  'conditional_safe_fix_or_suggestion',
])
const OxlintRules = Schema.Array(Schema.Struct({ scope: Schema.String, value: Schema.String, fix: Schema.String }))
const decodeRules = Schema.decodeUnknownSync(OxlintRules)

/** Rule codes with a safe fix, from `oxlint --rules -f json` (built-in rules only; plugins add their own). */
export const safeFixCodes = (rules: unknown): Set<string> =>
  new Set(
    decodeRules(rules)
      .filter((rule) => SAFE_FIX_KINDS.has(rule.fix))
      .map((rule) => ruleCode(rule.scope, rule.value)),
  )

/** The code oxlint prints for a rule. `--rules` spells scopes with `_` (`jsx_a11y`), diagnostics with `-`. */
export const ruleCode = (scope: string, rule: string): string => `${scope.split('_').join('-')}(${rule})`

// ---------------------------------------------------------------------------------------------------------------------
// effect-tsrs and effect-tsgo

const EffectDiagnostic = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  severity: Schema.String,
  code: Schema.Number,
  name: Schema.String,
  message: Schema.String,
})
export type EffectDiagnostic = typeof EffectDiagnostic.Type

/** A TypeScript diagnostic in effect-tsrs output; one about the options or the program as a whole has no location. */
const TypescriptDiagnostic = Schema.Struct({
  code: Schema.Number,
  severity: Schema.String,
  message: Schema.String,
  location: Schema.optional(Schema.Struct({ file: Schema.String, line: Schema.Number, column: Schema.Number })),
})

const EffectOutput = Schema.Struct({
  diagnostics: Schema.Array(EffectDiagnostic),
  // effect-tsrs reports the TypeScript diagnostics of the same program; effect-tsgo reports none and counts the files
  // it checked without the plugin instead.
  typescriptDiagnostics: Schema.optional(Schema.Array(TypescriptDiagnostic)),
  summary: Schema.Struct({ filesChecked: Schema.Number, filesWithoutPlugin: Schema.optional(Schema.Number) }),
})
export type EffectOutput = typeof EffectOutput.Type

/** `effect-tsrs diagnostics --format json` or `effect-tsgo diagnostics --format json` output. */
export const decodeEffect = Schema.decodeUnknownSync(EffectOutput)

/**
 * The code of an `@effect-diagnostics` directive that changes nothing. effect-tsrs names it `unusedDirective`,
 * effect-tsgo `effect(377000)`.
 */
export const UNUSED_DIRECTIVE = 377000

/** The TypeScript errors of effect-tsrs output, one line each as `tsc --pretty false` prints them. */
export const typescriptErrors = (output: EffectOutput): string[] =>
  (output.typescriptDiagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map(({ code, message, location }) => {
      const where =
        location === undefined
          ? ''
          : `${path.relative(repoRoot, location.file).split(path.sep).join('/')}(${location.line},${location.column}): `
      return `${where}error TS${code}: ${message}`
    })

/**
 * The diagnostics that count, with repository-relative paths: errors, warnings (a warning left on in tsconfig.base.json
 * is a finding) and directives that change nothing, whatever their severity, named `unusedDirective`. Messages and
 * suggestions are editor advice.
 */
export const gatingDiagnostics = (output: EffectOutput): EffectDiagnostic[] =>
  output.diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.severity === 'error' || diagnostic.severity === 'warning' || diagnostic.code === UNUSED_DIRECTIVE,
    )
    .map((diagnostic) => ({
      ...diagnostic,
      name: diagnostic.code === UNUSED_DIRECTIVE ? 'unusedDirective' : diagnostic.name,
      file: path.relative(repoRoot, diagnostic.file).split(path.sep).join('/'),
    }))

/**
 * Why a project's diagnostics are incomplete by effect-tsgo's count: files its tsconfig checks without the plugin, which
 * go unchecked. `label` names the project in the message. Undefined when every file was checked, and for effect-tsrs,
 * which does not count them (`missingPlugin` in effect.ts reads the tsconfig instead).
 */
export const uncheckedFiles = (label: string, output: EffectOutput): string | undefined =>
  (output.summary.filesWithoutPlugin ?? 0) > 0
    ? `${label}: ${output.summary.filesWithoutPlugin} files went unchecked because this tsconfig does not enable ` +
      `@effect/language-service. Extend tsconfig.base.json, or copy its plugin block (ADR 0030).`
    : undefined

/** Effect diagnostics as findings. They have no automatic fix here (quick fixes are editor-only). */
export const fromEffect = (output: EffectOutput): Finding[] =>
  gatingDiagnostics(output).map((diagnostic) => ({
    source: 'effect',
    rule: `effect(${diagnostic.name})`,
    file: diagnostic.file,
    line: diagnostic.line,
    fixable: false,
  }))

// ---------------------------------------------------------------------------------------------------------------------
// knip

const KnipOutput = Schema.Struct({ issues: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })
const decodeKnipOutput = Schema.decodeUnknownSync(KnipOutput)
const decodeIssueFile = Schema.decodeUnknownSync(Schema.Struct({ file: Schema.String }))
/** An issue item with a position; files and duplicate groups have none. */
const isPositioned = Schema.is(Schema.Struct({ line: Schema.Number }))
const isItemList = Schema.is(Schema.Array(Schema.Unknown))

/** Issue types `knip --fix` removes: the `export` keyword, or the manifest entry. */
const KNIP_FIXABLE = new Set(['exports', 'types', 'dependencies', 'devDependencies'])

/** `knip --reporter json` output as findings, one per issue item, under the rule `knip(<issue type>)`. */
export const fromKnip = (output: unknown): Finding[] =>
  decodeKnipOutput(output).issues.flatMap((issue) => {
    const file = decodeIssueFile(issue).file
    return Object.entries(issue).flatMap(([type, items]) =>
      type === 'file' || !isItemList(items)
        ? []
        : items.map((item) => ({
            source: 'knip' as const,
            rule: `knip(${type})`,
            file,
            line: isPositioned(item) ? item.line : 0,
            fixable: KNIP_FIXABLE.has(type),
          })),
    )
  })

// ---------------------------------------------------------------------------------------------------------------------
// aggregation

export interface RuleRow {
  readonly rule: string
  readonly source: Source
  readonly count: number
  readonly fixable: number
  /** Workspace directory → findings, largest first. */
  readonly workspaces: ReadonlyArray<readonly [string, number]>
}

export interface WorkspaceRow {
  readonly workspace: string
  readonly count: number
  /** Rule → findings, largest first. */
  readonly rules: ReadonlyArray<readonly [string, number]>
}

export interface Report {
  readonly total: number
  readonly fixable: number
  readonly sources: readonly Source[]
  readonly rules: readonly RuleRow[]
  readonly workspaces: readonly WorkspaceRow[]
}

const descending = (counts: Map<string, number>): Array<readonly [string, number]> =>
  [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

export const aggregate = (findings: readonly Finding[], sources: readonly Source[]): Report => {
  const rules = new Map<string, { source: Source; count: number; fixable: number; workspaces: Map<string, number> }>()
  const workspaces = new Map<string, Map<string, number>>()
  for (const finding of findings) {
    const workspace = workspaceOf(finding.file)
    const row = rules.get(finding.rule) ?? { source: finding.source, count: 0, fixable: 0, workspaces: new Map() }
    row.count += 1
    if (finding.fixable) row.fixable += 1
    bump(row.workspaces, workspace)
    rules.set(finding.rule, row)
    const perRule = workspaces.get(workspace) ?? new Map<string, number>()
    bump(perRule, finding.rule)
    workspaces.set(workspace, perRule)
  }
  return {
    total: findings.length,
    fixable: findings.filter((finding) => finding.fixable).length,
    sources,
    rules: [...rules]
      .map(([rule, row]) => ({
        rule,
        source: row.source,
        count: row.count,
        fixable: row.fixable,
        workspaces: descending(row.workspaces),
      }))
      .toSorted((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    workspaces: [...workspaces]
      .map(([workspace, perRule]) => ({
        workspace,
        count: [...perRule.values()].reduce((sum, n) => sum + n, 0),
        rules: descending(perRule),
      }))
      .toSorted((a, b) => b.count - a.count || a.workspace.localeCompare(b.workspace)),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// rendering

const top = (entries: ReadonlyArray<readonly [string, number]>, limit: number, code: boolean): string => {
  const shown = entries.slice(0, limit).map(([key, n]) => `${code ? `\`${key}\`` : key} ${n}`)
  const rest = entries.length - limit
  return rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ')
}

export const renderMarkdown = (report: Report): string => {
  const lines = [
    '# Lint report',
    '',
    `${report.total} findings (${report.fixable} with a safe autofix) in ${report.workspaces.length} workspaces. ` +
      `Sources: ${report.sources.join(', ')}.`,
  ]
  if (report.total === 0) return `${lines.join('\n')}\n`
  lines.push(
    '',
    '## By rule',
    '',
    '| Rule | Findings | Safe autofix | Workspaces |',
    '| :-- | --: | --: | :-- |',
    ...report.rules.map(
      (row) => `| \`${row.rule}\` | ${row.count} | ${row.fixable} | ${top(row.workspaces, 4, false)} |`,
    ),
    '',
    '## By workspace',
    '',
    '| Workspace | Findings | Rules |',
    '| :-- | --: | :-- |',
    ...report.workspaces.map((row) => `| ${row.workspace} | ${row.count} | ${top(row.rules, 4, true)} |`),
  )
  return `${lines.join('\n')}\n`
}

export const renderJson = (report: Report): string => `${JSON.stringify(report, null, 2)}\n`
