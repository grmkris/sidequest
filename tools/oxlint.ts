/**
 * `bun run lint [oxlint arguments]`: oxlint from the repository root on the pinned type-aware backend
 * (tools/tsrs-lint.ts); package.json gives the default arguments (`-c oxlint.config.ts .`). A bare `oxlint` has no
 * backend and fails on its first type-aware rule, on purpose: there is nothing to fall back to.
 */
import { bin, repoRoot } from './run.ts'
import { oxlintEnv } from './tsrs-lint.ts'

const child = Bun.spawn([bin('oxlint'), ...Bun.argv.slice(2)], {
  cwd: repoRoot,
  env: await oxlintEnv(),
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exit(await child.exited)
