import { Schema } from 'effect'

/**
 * What shipped, from the public repository: commits on dev whose message carries `Commons-Gaps: 8, 11` or
 * `Commons-Roadmap: 4` trailers, counted only once a push run on dev has a successful deploy-dev job whose head
 * includes the commit. A workflow_dispatch run skips deploy-dev, so it never counts.
 */
export const REPOSITORY = 'grmkris/sidequest'

const Commit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({ message: Schema.String, committer: Schema.Struct({ date: Schema.String }) }),
})
const Runs = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ id: Schema.Number, head_sha: Schema.String, event: Schema.String })),
})
const Jobs = Schema.Struct({
  jobs: Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.NullOr(Schema.String) })),
})
const Compare = Schema.Struct({ status: Schema.String })

export interface Shipped {
  readonly sha: string
  readonly date: string
  readonly gaps: readonly number[]
  readonly items: readonly number[]
}

export class RateLimited extends Error {
  constructor(readonly resetAt: number) {
    super(`GitHub rate limit until ${new Date(resetAt * 1000).toISOString()}`)
  }
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>

/** Ids named by a trailer line, e.g. `Commons-Gaps: 2, 3, 5` → [2, 3, 5]. */
export function trailerIds(message: string, key: 'Commons-Gaps' | 'Commons-Roadmap'): number[] {
  const ids = message
    .split('\n')
    .filter((line) => line.startsWith(`${key}:`))
    .flatMap((line) => line.slice(key.length + 1).split(','))
    .map((part) => Number(part.trim()))
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))]
}

export class GitHubShip {
  readonly #fetch: Fetch
  readonly #headers: Record<string, string>

  constructor(fetchFn: Fetch = fetch, token?: string) {
    this.#fetch = fetchFn
    this.#headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'sidequest-maintainer',
      ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }),
    }
  }

  async #get<T>(path: string, schema: Schema.Codec<T, unknown>): Promise<T> {
    const response = await this.#fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, { headers: this.#headers })
    if (response.status === 403 || response.status === 429)
      throw new RateLimited(Number(response.headers.get('x-ratelimit-reset') ?? Math.floor(Date.now() / 1000) + 3600))
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`)
    return Schema.decodeUnknownSync(schema)(await response.json())
  }

  /** The head of the newest push run on dev whose deploy-dev job succeeded, if any of the last ten. */
  async deployedHead(): Promise<string | undefined> {
    const { workflow_runs: runs } = await this.#get(
      '/actions/runs?branch=dev&event=push&status=success&per_page=10',
      Runs,
    )
    for (const run of runs) {
      if (run.event !== 'push') continue
      const { jobs } = await this.#get(`/actions/runs/${run.id}/jobs`, Jobs)
      if (jobs.some((job) => job.name === 'deploy-dev' && job.conclusion === 'success')) return run.head_sha
    }
    return undefined
  }

  /** Trailer commits on dev after `since` (ISO), oldest first, that the deployed head already contains. */
  async shipped(since: string, done: ReadonlySet<string>): Promise<Shipped[]> {
    const commits = await this.#get(
      `/commits?sha=dev&since=${encodeURIComponent(since)}&per_page=100`,
      Schema.Array(Commit),
    )
    const named = commits
      .map((c) => ({
        sha: c.sha,
        date: c.commit.committer.date,
        gaps: trailerIds(c.commit.message, 'Commons-Gaps'),
        items: trailerIds(c.commit.message, 'Commons-Roadmap'),
      }))
      .filter((c) => !done.has(c.sha) && (c.gaps.length > 0 || c.items.length > 0))
      .toReversed()
    if (named.length === 0) return []
    const head = await this.deployedHead()
    if (head === undefined) return []
    const live: Shipped[] = []
    for (const commit of named) {
      const { status } = await this.#get(`/compare/${commit.sha}...${head}`, Compare)
      if (status === 'ahead' || status === 'identical') live.push(commit)
    }
    return live
  }
}
