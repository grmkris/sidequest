/**
 * Running the repository's checks from tooling. Expensive commands go through `heavy` when it is on PATH (the netcup
 * box; see AGENTS.md): it runs a few heavy jobs at a time and exits 75 while every slot is busy, which means "retry",
 * never "failed". Output is captured by the caller, never piped through a shell, so the command's own exit status is
 * what comes back.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

export const repoRoot = path.resolve(import.meta.dirname, '..')

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  /** Wrap the command in `heavy` when it is installed. */
  readonly heavy?: boolean
  /** Stream output to this process instead of capturing it. */
  readonly inherit?: boolean
  /** The child's environment; by default this process's. */
  readonly env?: NodeJS.ProcessEnv
}

const BUSY = 75
const RETRY_EVERY_MS = 15_000
const MAX_RETRIES = 20

/**
 * `heavy` is on PATH and has a directory for its slot locks: `$XDG_RUNTIME_DIR`, by default `/run/user/<uid>`. A service
 * user without a login session, such as the CI runner, has no such directory; there `heavy` reports every slot busy
 * (exit 75) forever, so the command runs without it.
 */
export const heavyAvailable = (): boolean =>
  Bun.which('heavy') !== null && existsSync(path.join('/run/user', String(process.getuid?.() ?? 'none')))

const once = async (argv: readonly string[], { inherit = false, env }: RunOptions): Promise<RunResult> => {
  const child = Bun.spawn([...argv], {
    cwd: repoRoot,
    ...(env === undefined ? {} : { env }),
    stdout: inherit ? 'inherit' : 'pipe',
    stderr: inherit ? 'inherit' : 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    inherit ? '' : new Response(child.stdout).text(),
    inherit ? '' : new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Runs `argv` from the repository root; with `heavy`, waits for a free slot (up to 20 retries, 15 s apart). */
export const run = async (argv: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
  const wrapped = options.heavy === true && heavyAvailable() ? ['heavy', ...argv] : argv
  for (let attempt = 0; ; attempt++) {
    const result = await once(wrapped, options)
    if (result.exitCode !== BUSY || wrapped[0] !== 'heavy' || attempt >= MAX_RETRIES) return result
    console.error(`heavy: every slot is busy (exit 75); retrying in ${RETRY_EVERY_MS / 1000} s`)
    await Bun.sleep(RETRY_EVERY_MS)
  }
}

/** A repository binary from node_modules/.bin, so tools never depend on what is on PATH. */
export const bin = (name: string): string => path.join(repoRoot, 'node_modules/.bin', name)
