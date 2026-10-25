/**
 * `typecheck`: the TypeScript diagnostics of the given tsconfigs on tsrs (ADR 0030).
 *
 *   bun ../../tools/typecheck.ts tsconfig.json                    from a workspace's `typecheck` script
 *   bun tools/typecheck.ts --workspaces scripts/ci/tsconfig.json  `bun run typecheck`: the root projects, then every
 *                                                                 workspace through turbo
 *
 * Each project runs once through effect-tsrs with `--rules none` (tools/pass.ts), which reports what tsc reports. The
 * check fails on a TypeScript error or when effect-tsrs fails. The Effect
 * diagnostics are `lint:gate`'s (tools/findings.ts), judged against tools/lint-baseline.json. Tsconfig paths are relative
 * to the current directory. This script does not use `heavy`; run the whole task through it (`heavy bun run typecheck`).
 */
import path from 'node:path'
import { typescriptPass } from './pass.ts'
import { bin, run } from './run.ts'

/** Checks one tsconfig and prints its TypeScript errors. Returns whether it passed. */
const check = async (tsconfig: string): Promise<boolean> => {
  const result = await typescriptPass(path.resolve(tsconfig))
  for (const error of result.typescript) console.log(error)
  for (const failure of result.failures) console.error(failure)
  console.log(`${result.label}: ${result.typescript.length} TypeScript errors (tsrs)`)
  return result.typescript.length === 0 && result.failures.length === 0
}

/** Every workspace's typecheck, at turbo's concurrency; all of them run even when one fails. */
const workspaces = async (): Promise<boolean> => {
  const argv = [bin('turbo'), 'run', 'typecheck', '--continue']
  console.log(`$ ${argv.join(' ')}`)
  return (await run(argv, { inherit: true })).exitCode === 0
}

const args = Bun.argv.slice(2)
const tsconfigs = args.filter((arg) => arg !== '--workspaces')
if (tsconfigs.length === 0) {
  console.error('usage: bun tools/typecheck.ts [--workspaces] <tsconfig>...')
  process.exit(2)
}
let passed = true
for (const tsconfig of tsconfigs) passed = (await check(tsconfig)) && passed
if (args.includes('--workspaces')) passed = (await workspaces()) && passed
process.exit(passed ? 0 : 1)
