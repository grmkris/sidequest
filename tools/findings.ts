/**
 * The collectors of `bun run lint:report` and `bun run lint:gate`: every finding of oxlint (type-aware), the Effect
 * diagnostics of every typecheck project (tools/pass.ts, ADR 0030), and unused code and dependency issues from knip,
 * together with the reasons a collection is incomplete. Each tool runs from the repository root, through `heavy` when
 * it is installed (tools/run.ts).
 */
import { Schema } from 'effect'
import path from 'node:path'
import { effectProjects } from './effect.ts'
import type { Project } from './effect.ts'
import { effectPass } from './pass.ts'
import { fromEffect, fromKnip, fromOxlint, safeFixCodes } from './report.ts'
import type { Finding, Source } from './report.ts'
import { bin, repoRoot, run } from './run.ts'
import type { RunResult } from './run.ts'

export const SOURCES: readonly Source[] = ['oxlint', 'effect', 'knip']

/** The oxlint config the gates lint with. */
export const OXLINT_CONFIG = path.join(repoRoot, 'oxlint.config.ts')

export interface Collected {
  readonly findings: readonly Finding[]
  /** Why `findings` is incomplete: a tool that did not run, or a project whose files went unchecked. */
  readonly failures: readonly string[]
}

const NOTHING: Collected = { findings: [], failures: [] }

/** Each tool exits 1 when it reports findings; any other non-zero exit means it did not run. */
const didNotRun = (label: string, result: RunResult): readonly string[] =>
  result.exitCode > 1 ? [`${label} exited ${result.exitCode}\n${result.stderr.trim()}`] : []

// ---------------------------------------------------------------------------------------------------------------------
// oxlint

const ConfigModule = Schema.Struct({
  default: Schema.Struct({
    jsPlugins: Schema.optional(
      Schema.NullOr(
        Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String, specifier: Schema.String })])),
      ),
    ),
  }),
})
const decodeConfig = Schema.decodeUnknownSync(ConfigModule)
/** A `jsPlugins` entry that is a bare path or package name (the other form is `{ name, specifier }`). */
const isPath = Schema.is(Schema.String)

const PluginModule = Schema.Struct({
  default: Schema.Struct({
    meta: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
    rules: Schema.Record(
      Schema.String,
      Schema.Struct({ meta: Schema.optional(Schema.Struct({ fixable: Schema.optional(Schema.String) })) }),
    ),
  }),
})
const decodePlugin = Schema.decodeUnknownSync(PluginModule)

/** Rule codes of the config's JS plugins whose rules declare a fix. Plugin paths are relative to the config file. */
const pluginFixCodes = async (config: string): Promise<Set<string>> => {
  const codes = new Set<string>()
  for (const entry of decodeConfig(await import(config)).default.jsPlugins ?? []) {
    const specifier = isPath(entry) ? entry : entry.specifier
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(config), specifier) : specifier
    const plugin = decodePlugin(await import(resolved)).default
    const name = isPath(entry) ? (plugin.meta?.name ?? specifier) : entry.name
    for (const [rule, definition] of Object.entries(plugin.rules)) {
      if (definition.meta?.fixable !== undefined) codes.add(`${name}(${rule})`)
    }
  }
  return codes
}

/** The whole repository, type-aware, with `config`. */
export const oxlintFindings = async (config: string): Promise<Collected> => {
  const rules = await run([bin('oxlint'), '--rules', '-f', 'json'])
  const fixCodes = new Set([...safeFixCodes(JSON.parse(rules.stdout)), ...(await pluginFixCodes(config))])
  const lint = await run([bin('oxlint'), '-c', config, '-f', 'json', '.'], { heavy: true })
  const failures = didNotRun('oxlint', lint)
  if (failures.length > 0) return { findings: [], failures }
  if (lint.stderr.trim() !== '') console.error(lint.stderr.trim())
  return { findings: fromOxlint(JSON.parse(lint.stdout), (code) => fixCodes.has(code)), failures: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Effect diagnostics

/** Projects checked at the same time. Each is a full type check: effect-tsrs holds at most about 0.5 GB on one thread. */
const EFFECT_CONCURRENCY = 4

/**
 * One project's Effect findings. effect-tsrs reports the project's TypeScript errors in the same run; a project with any
 * fails the collection, since its Effect diagnostics are incomplete.
 */
const effectProject = async ({ dir, tsconfig }: Project): Promise<Collected> => {
  const result = await effectPass(path.join(dir, tsconfig))
  const typescript =
    result.typescript.length === 0
      ? []
      : [`${result.label}: ${result.typescript.length} TypeScript errors (\`bun run typecheck\` lists them)`]
  return {
    findings: result.effect === undefined ? [] : fromEffect(result.effect),
    failures: [...result.failures, ...typescript],
  }
}

/** `fn` over `items`, at most `limit` at a time; the results keep the order of `items`. */
const mapLimit = async <A, B>(items: readonly A[], limit: number, fn: (item: A) => Promise<B>): Promise<B[]> => {
  const pending = items.entries()
  const results = new Map<number, B>()
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) results.set(index, await fn(item))
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return [...results].toSorted(([a], [b]) => a - b).map(([, result]) => result)
}

/**
 * Every project's Effect findings; one a file gets in several programs counts once. effect-tsrs reports only the files a
 * project's tsconfig includes (since 0.2.2, as effect-tsgo did), so a file a project merely imports (`infra/stage.ts`
 * through `alchemy.run.ts`) counts nowhere.
 */
export const effectFindings = async (): Promise<Collected> => {
  const results = await mapLimit(effectProjects(), EFFECT_CONCURRENCY, effectProject)
  const seen = new Map<string, Finding>()
  for (const finding of results.flatMap((result) => result.findings)) {
    seen.set(`${finding.file}:${finding.line}:${finding.rule}`, finding)
  }
  return { findings: [...seen.values()], failures: results.flatMap((result) => result.failures) }
}

// ---------------------------------------------------------------------------------------------------------------------
// knip

/** JSON omits configuration hints; the symbols reporter writes them to stderr in the same run. */
export const collectKnipResult = (result: RunResult): Collected => {
  const failures = [...didNotRun('knip', result)]
  if (failures.length > 0) return { findings: [], failures }
  const findings = fromKnip(JSON.parse(result.stdout.split('\n')[0] ?? ''))
  const diagnostics = result.stderr
    .replaceAll(String.fromCharCode(27), '')
    .replace(/\[[0-9;]*m/gu, '')
    .trim()
  if (/Configuration hints \(\d+\)/u.test(diagnostics)) {
    failures.push(`knip configuration hints must be fixed:\n${diagnostics}`)
  } else if (result.exitCode !== 0 && findings.length === 0) {
    failures.push(`knip exited ${result.exitCode} without issue records:\n${diagnostics}`)
  }
  return { findings, failures }
}

export const knipFindings = async (): Promise<Collected> =>
  collectKnipResult(
    await run(
      [bin('knip'), '--reporter', 'json', '--reporter', 'symbols', '--treat-config-hints-as-errors', '--no-progress'],
      { heavy: true },
    ),
  )

// ---------------------------------------------------------------------------------------------------------------------

/** The findings of `sources`, one tool after another (oxlint with `config`). */
export const collect = async (sources: readonly Source[], config: string = OXLINT_CONFIG): Promise<Collected> => {
  const parts = [
    sources.includes('oxlint') ? await oxlintFindings(config) : NOTHING,
    sources.includes('effect') ? await effectFindings() : NOTHING,
    sources.includes('knip') ? await knipFindings() : NOTHING,
  ]
  return { findings: parts.flatMap((part) => part.findings), failures: parts.flatMap((part) => part.failures) }
}
