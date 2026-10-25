/**
 * The pure half of `bun run typecheck` and of the Effect collector of `lint:gate` (ADR 0030, ported from goblin's
 * tools/effect.ts): which tsconfigs the repository checks, the effect-tsrs command that checks them, and the tsconfig
 * reading the checks need. tools/pass.ts runs one project's pass; tools/report.ts turns its output into findings. Node APIs only: Vitest
 * runs under Node.
 */
import { Schema } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
import { nodes } from './graph.ts'
import { UNUSED_DIRECTIVE } from './report.ts'
import type { EffectOutput } from './report.ts'
import { repoRoot } from './run.ts'

/** The plugin name effect-tsrs and editors' `@effect/tsgo` read their options under, in `compilerOptions.plugins`. */
export const PLUGIN = '@effect/language-service'

/**
 * The effect-tsrs binary: the static executable of `@yielded/effect-tsrs`'s package for this platform, found as its Node
 * launcher (`bin/native.mjs`) finds it. Running it directly needs no Node and no launcher process.
 */
export const effectTsrs = (): string => {
  const fromLauncher = createRequire(createRequire(import.meta.url).resolve('@yielded/effect-tsrs/package.json'))
  return fromLauncher.resolve(`@yielded/effect-tsrs-${process.platform}-${process.arch}/bin/effect-tsrs`)
}

/**
 * The command that prints one project's diagnostics as JSON (`decodeEffect` in report.ts reads it). `--type-check` adds
 * the TypeScript diagnostics tsc reports, which effect-tsrs leaves out by default since 0.2.2; with `--rules none` it is
 * the compiler alone, what `bun run typecheck` runs.
 */
export const effectArgs = (tsconfig: string, rules: 'all' | 'none' = 'all'): string[] => [
  effectTsrs(),
  'diagnostics',
  '-p',
  path.resolve(repoRoot, tsconfig),
  '--type-check',
  '--format',
  'json',
  ...(rules === 'none' ? ['--rules', 'none'] : []),
]

/** Tsconfigs a `typecheck` script checks: the arguments of `tools/typecheck.ts`, none when it does not run it. */
export const typecheckProjects = (script: string): string[] => {
  const command = script.split('&&').find((part) => part.includes('typecheck.ts'))
  if (command === undefined) return []
  const words = command.trim().split(/\s+/u)
  return words
    .slice(words.findIndex((word) => word.endsWith('typecheck.ts')) + 1)
    .filter((word) => !word.startsWith('-'))
}

export interface Project {
  /** Workspace directory, repository-relative; `.` for the root tsconfig. */
  readonly dir: string
  readonly tsconfig: string
}

const Manifest = Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) })
const decodeManifest = Schema.decodeUnknownSync(Manifest)

const scriptsOf = (dir: string): Readonly<Record<string, string>> =>
  decodeManifest(JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'))).scripts ?? {}

/** Every workspace's `typecheck` script (undefined when it has none). */
export const workspaceScripts = (): Array<{ readonly dir: string; readonly typecheck: string | undefined }> =>
  nodes.map((node) => ({ dir: node.dir, typecheck: scriptsOf(node.dir)['typecheck'] }))

/**
 * Every project `bun run typecheck` checks: the root script's tsconfigs, then each workspace's. A workspace without a
 * `typecheck` (contracts, Solidity) has none; one whose `typecheck` does not run tools/typecheck.ts would skip the
 * checks, so it throws.
 */
export const effectProjects = (): Project[] => {
  const projects: Project[] = typecheckProjects(scriptsOf('.')['typecheck'] ?? '').map((tsconfig) => ({
    dir: '.',
    tsconfig,
  }))
  for (const { dir, typecheck } of workspaceScripts()) {
    if (typecheck === undefined) continue
    const checked = typecheckProjects(typecheck)
    if (checked.length === 0)
      throw new Error(`${dir}: its typecheck script must run tools/typecheck.ts on its tsconfigs`)
    projects.push(...checked.map((tsconfig) => ({ dir, tsconfig })))
  }
  return projects
}

/** JSON with comments and trailing commas, as tsconfig files allow, reduced to plain JSON. */
export const stripJsonc = (text: string): string => {
  let out = ''
  let i = 0
  while (i < text.length) {
    const char = text[i] ?? ''
    if (char === '"') {
      const end = endOfString(text, i)
      out += text.slice(i, end)
      i = end
    } else if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i)
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i) === -1 ? text.length : text.indexOf('*/', i) + 2
    } else {
      out += char
      i++
    }
  }
  return out.replace(/,(\s*[}\]])/gu, '$1')
}

/** The index just past the string literal that starts at `start`. */
const endOfString = (text: string, start: number): number => {
  let i = start + 1
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
  return i + 1
}

type PluginEntry = Readonly<Record<string, unknown>>
const Tsconfig = Schema.Struct({
  extends: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  compilerOptions: Schema.optional(
    Schema.Struct({ plugins: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))) }),
  ),
})
const decodeTsconfig = Schema.decodeUnknownSync(Tsconfig)

/** An `extends` that names one tsconfig, not a list. */
const isName = Schema.is(Schema.String)

/**
 * The files a tsconfig's `extends` names, in order, as TypeScript finds them: relative to the tsconfig, with `.json`
 * added when the name has none. A package's tsconfig is not followed: it throws, so the check never guesses.
 */
const extended = (file: string, names: string | readonly string[] | undefined): string[] =>
  (names === undefined ? [] : isName(names) ? [names] : names).map((name) => {
    if (!/^\.\.?\//u.test(name)) throw new Error(`${file}: cannot follow extends "${name}"; name a relative path`)
    const target = path.resolve(path.dirname(file), name)
    return existsSync(target) || target.endsWith('.json') ? target : `${target}.json`
  })

/**
 * The `compilerOptions.plugins` a tsconfig ends up with: its own when it sets them, else those of what it extends, the
 * last `extends` entry that has any winning. TypeScript replaces `plugins` from a parent, never merges it.
 */
const effectivePlugins = (file: string, seen: ReadonlySet<string>): readonly PluginEntry[] | undefined => {
  if (seen.has(file)) throw new Error(`${file}: extends itself`)
  const config = decodeTsconfig(JSON.parse(stripJsonc(readFileSync(file, 'utf8'))))
  if (config.compilerOptions?.plugins !== undefined) return config.compilerOptions.plugins
  return extended(file, config.extends)
    .toReversed()
    .map((parent) => effectivePlugins(parent, new Set([...seen, file])))
    .find((plugins) => plugins !== undefined)
}

/** The `@effect/language-service` entry a tsconfig (repository-relative or absolute) sets or inherits, if any. */
export const pluginBlock = (tsconfig: string): PluginEntry | undefined =>
  effectivePlugins(path.resolve(repoRoot, tsconfig), new Set())?.find((plugin) => plugin['name'] === PLUGIN)

/**
 * Why a project's Effect diagnostics would be incomplete: its tsconfig neither sets nor inherits the plugin block, so
 * the checker would run without the repository's severities. Undefined when it has the block. Read from the tsconfig
 * first; effect-tsrs then also counts the files it checked without the plugin (`uncheckedFiles` in report.ts).
 */
export const missingPlugin = (tsconfig: string): string | undefined =>
  pluginBlock(tsconfig) === undefined
    ? `${path.relative(repoRoot, path.resolve(repoRoot, tsconfig))}: does not enable ${PLUGIN}, so its files would ` +
      `go unchecked. Extend tsconfig.base.json, or copy its plugin block (ADR 0030).`
    : undefined

/**
 * effect-tsrs also reads directive-shaped text inside strings (a lint rule's test cases), as effect-tsgo did, and
 * reports it as a directive that changes nothing. Only a directive inside a real comment is kept. A source that cannot
 * be read or parsed throws: the gate fails instead of guessing.
 */
export const verifiedEffectOutput = (
  output: EffectOutput,
  readSource: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): EffectOutput => {
  const spans = new Map<string, { source: string; comments: readonly { start: number; end: number }[] }>()
  return {
    ...output,
    diagnostics: output.diagnostics.filter((diagnostic) => {
      if (diagnostic.code !== UNUSED_DIRECTIVE) return true
      let parsed = spans.get(diagnostic.file)
      if (parsed === undefined) {
        const source = readSource(diagnostic.file)
        const result = parseSync(diagnostic.file, source)
        if (result.errors.length > 0)
          throw new Error(`Effect directive check cannot parse ${diagnostic.file}: ${result.errors[0]?.message}`)
        parsed = { source, comments: result.comments }
        spans.set(diagnostic.file, parsed)
      }
      const lines = parsed.source.split('\n')
      const offset =
        lines.slice(0, diagnostic.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + diagnostic.column - 1
      return parsed.comments.some((comment) => comment.start <= offset && offset < comment.end)
    }),
  }
}
