/**
 * `bun run check:files <paths...>`: the gates for the files you changed, and nothing else.
 *
 *   bun run check:files apps/api/src/mcp.ts packages/sdk     files and directories, relative to the repo root
 *   bun run check:files --lint-only apps/api/src/mcp.ts         format and lint only: no turbo, no typecheck
 *
 * Paths are explicit on purpose. Other agents edit this checkout at the same time, so "everything git status shows"
 * would check (and blame you for) their half-finished work. Directories expand to their tracked and untracked files.
 *
 * Steps, all of them run and a summary table at the end; the exit status is non-zero if any step failed:
 *   1. format     oxfmt --check on the files oxfmt.config.ts does not ignore
 *   2. lint       oxlint (type-aware through the config) on lintable files oxlint.config.ts does not ignore
 *   3. typecheck  turbo typecheck for the owning workspaces (tools/graph.ts); tsc on
 *                 the root tsconfig for root files
 *   4. graph      bun run graph, when a package.json or tools/graph.ts is among the files
 *   5. agents     bun run agents:check, once it exists, when an agent file is among the files
 * Steps 2 and 3 run through `heavy` when it is installed (retrying while every slot is busy). `--lint-only` skips heavy:
 * linting a handful of files is cheap, and parallel fixers must not queue behind the gates. `heavy bun run check` before
 * a push is still required: this checks your files, not the repository.
 */
import { Schema } from 'effect'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { nodes } from '../tools/graph.ts'
import { ROOT_WORKSPACE, workspaceOf } from '../tools/report.ts'
import { bin, repoRoot, run } from '../tools/run.ts'

type Outcome = 'pass' | 'fail' | 'skipped'
interface StepResult {
  readonly step: string
  readonly outcome: Outcome
  readonly detail: string
}

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u
const TYPED = /\.(?:[cm]?[jt]sx?|json)$/u
const AGENT_FILE =
  /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md)$|^(?:\.agents|\.claude|\.codex|\.cursor|docs\/agents|docs\/adr)\/|^GLOSSARY\.md$/u

const IgnoreConfig = Schema.Struct({
  default: Schema.Struct({ ignorePatterns: Schema.optional(Schema.Array(Schema.String)) }),
})
const decodeIgnoreConfig = Schema.decodeUnknownSync(IgnoreConfig)
const RootManifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })

/** The config's ignorePatterns as matchers over repository-relative paths. */
const ignoredBy = async (configFile: string): Promise<(file: string) => boolean> => {
  const patterns = decodeIgnoreConfig(await import(path.join(repoRoot, configFile))).default.ignorePatterns ?? []
  const globs = patterns.map((pattern) => new Bun.Glob(pattern))
  return (file) => globs.some((glob) => glob.match(file))
}

const toRelative = (input: string): string =>
  path.relative(repoRoot, path.resolve(repoRoot, input)).split(path.sep).join('/')

/** Files named on the command line; directories expand through git (tracked plus untracked, minus .gitignore). */
const expand = async (inputs: readonly string[]): Promise<{ files: string[]; missing: string[] }> => {
  const files = new Set<string>()
  const missing: string[] = []
  for (const input of inputs.map(toRelative)) {
    if (!existsSync(path.join(repoRoot, input))) {
      missing.push(input)
    } else if (statSync(path.join(repoRoot, input)).isDirectory()) {
      const listed = await run(['git', 'ls-files', '-co', '--exclude-standard', '--', input])
      for (const file of listed.stdout.split('\n')) if (file !== '') files.add(file)
    } else {
      files.add(input)
    }
  }
  return { files: [...files].toSorted(), missing }
}

const announce = (argv: readonly string[]): void => {
  console.info(`\n$ ${argv.map((arg) => (arg.startsWith(repoRoot) ? path.relative(repoRoot, arg) : arg)).join(' ')}`)
}

const format = async (files: readonly string[]): Promise<StepResult> => {
  const ignored = await ignoredBy('oxfmt.config.ts')
  const targets = files.filter((file) => !ignored(file))
  if (targets.length === 0) return { step: 'format', outcome: 'skipped', detail: 'every file is ignored by oxfmt' }
  const argv = [bin('oxfmt'), '-c', 'oxfmt.config.ts', '--check', '--no-error-on-unmatched-pattern', ...targets]
  announce(argv)
  const result = await run(argv, { inherit: true })
  const skipped = files.length - targets.length
  const detail = `${targets.length} files${skipped > 0 ? `, ${skipped} skipped (ignored)` : ''}`
  return { step: 'format', outcome: result.exitCode === 0 ? 'pass' : 'fail', detail }
}

const lint = async (files: readonly string[], heavy: boolean): Promise<StepResult> => {
  const ignored = await ignoredBy('oxlint.config.ts')
  const lintable = files.filter((file) => LINTABLE.test(file))
  const targets = lintable.filter((file) => !ignored(file))
  if (targets.length === 0) {
    const why = lintable.length === 0 ? 'no lintable files' : 'every lintable file is ignored by oxlint'
    return { step: 'lint', outcome: 'skipped', detail: why }
  }
  const argv = [bin('oxlint'), '-c', 'oxlint.config.ts', ...targets]
  announce(argv)
  const result = await run(argv, { heavy, inherit: true })
  const skipped = lintable.length - targets.length
  const detail = `${targets.length} files${skipped > 0 ? `, ${skipped} skipped (ignored)` : ''}`
  return { step: 'lint', outcome: result.exitCode === 0 ? 'pass' : 'fail', detail }
}

/** Root files use the existing project that includes them; repository tooling is in tools/tsconfig.json. */
const rootChecks = async (files: readonly string[]): Promise<StepResult[]> => {
  const configs = new Set<string>()
  for (const file of files.filter((file) => TYPED.test(file) && workspaceOf(file) === ROOT_WORKSPACE)) {
    if (file.startsWith('scripts/ci/')) configs.add('scripts/ci/tsconfig.json')
    else if (['scripts/check-files.ts', 'scripts/migrations-lock.ts'].includes(file)) configs.add('tools/tsconfig.json')
    else if (/\.[cm]?[jt]sx?$/u.test(file)) configs.add('tsconfig.json')
  }
  const results: StepResult[] = []
  for (const config of configs) {
    const argv = [bin('tsc'), '-p', config]
    announce(argv)
    const result = await run(argv, { heavy: true, inherit: true })
    results.push({ step: 'typecheck', outcome: result.exitCode === 0 ? 'pass' : 'fail', detail: config })
  }
  return results
}

const typecheck = async (files: readonly string[]): Promise<StepResult[]> => {
  const owners = new Set(files.filter((file) => TYPED.test(file)).map(workspaceOf))
  if (owners.size === 0) return [{ step: 'typecheck', outcome: 'skipped', detail: 'no TypeScript or JSON files' }]
  const results: StepResult[] = []
  const names = nodes.filter((node) => owners.has(node.dir)).map((node) => node.name)
  if (names.length > 0) {
    const tasks = ['typecheck']
    const argv = [
      bin('turbo'),
      'run',
      ...tasks,
      '--output-logs=errors-only',
      ...names.map((name) => `--filter=${name}`),
    ]
    announce(argv)
    const result = await run(argv, { heavy: true, inherit: true })
    results.push({
      step: tasks.join(' + '),
      outcome: result.exitCode === 0 ? 'pass' : 'fail',
      detail: names.join(', '),
    })
  }
  if (owners.has(ROOT_WORKSPACE)) results.push(...(await rootChecks(files)))
  return results
}

const script = async (name: string, reason: string): Promise<StepResult> => {
  const argv = ['bun', 'run', name]
  announce(argv)
  const result = await run(argv, { inherit: true })
  return { step: name, outcome: result.exitCode === 0 ? 'pass' : 'fail', detail: reason }
}

const usage = 'usage: bun run check:files [--lint-only] <file-or-directory>...'
const args = Bun.argv.slice(2)
const lintOnly = args.includes('--lint-only')
const inputs = args.filter((arg) => arg !== '--lint-only')
const unknownFlag = inputs.find((arg) => arg.startsWith('--'))
if (unknownFlag !== undefined || inputs.length === 0) {
  console.error(unknownFlag === undefined ? usage : `unknown option ${unknownFlag}\n${usage}`)
  process.exit(2)
}

const { files, missing } = await expand(inputs)
for (const file of missing) console.info(`skipped (does not exist): ${file}`)
const results: StepResult[] = [await format(files), await lint(files, !lintOnly)]
if (!lintOnly) {
  const scripts = Schema.decodeUnknownSync(RootManifest)(
    await Bun.file(path.join(repoRoot, 'package.json')).json(),
  ).scripts
  results.push(...(await typecheck(files)))
  if (files.some((file) => file.endsWith('package.json') || file === 'tools/graph.ts')) {
    results.push(await script('graph', 'a manifest or tools/graph.ts changed'))
  }
  if ('agents:check' in scripts && files.some((file) => AGENT_FILE.test(file))) {
    results.push(await script('agents:check', 'an agent file changed'))
  }
}

console.info(`\ncheck:files${lintOnly ? ' --lint-only' : ''}: ${files.length} files`)
console.info('| Step | Result | Detail |\n| :-- | :-- | :-- |')
for (const result of results) console.info(`| ${result.step} | ${result.outcome} | ${result.detail} |`)
if (results.some((result) => result.outcome === 'fail')) process.exitCode = 1
