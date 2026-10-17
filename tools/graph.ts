/**
 * The workspace graph: one node per workspace, what it owns, which runtime it runs in, and which workspaces it may
 * import. It is the single declaration behind two checks:
 *
 * - `tools/oxlint/boundaries.ts` (lint, per file): a `@sidequest/*` import must be a declared edge, and runtime-bound
 *   modules (`bun`, `bun:*`, `@effect/platform-bun`, `cloudflare:*`, `node:*`) must suit the file's runtime.
 * - `tools/check-graph.ts` (`bun run graph`, whole repo): every workspace has a node, edges equal the manifests, and a
 *   workspace no app reaches says why it exists (`seam`).
 *
 * External packages are not listed here: an import of a package the workspace does not declare is knip's `unlisted`
 * finding. Widen a boundary by editing this file and saying why in the commit, never by working around the rule.
 */

/**
 * Where code runs. `cloud`: Workers (nodejs_compat, `cloudflare:*`). `shared`: runs wherever its importers run, so no
 * runtime-bound module but `node:*`. `browser`: browser bundles, no `node:*`. `daemon`: Bun processes. `test`: Vitest
 * under Node (`cloudflare:workers` is aliased to a stub). `tooling`: scripts, stacks and configs run by Bun or the
 * Alchemy CLI.
 */
export type Runtime = 'cloud' | 'shared' | 'browser' | 'daemon' | 'test' | 'tooling'

export interface Node {
  readonly dir: string
  readonly name: string
  readonly role: string
  readonly runtime: Runtime
  readonly mayImport: readonly string[]
  readonly zones?: Readonly<Record<string, Runtime>>
  readonly seam?: { readonly consumer: string; readonly reason: string }
}

export const zones: Readonly<Record<string, Runtime>> = {
  scripts: 'tooling',
  test: 'test',
  tests: 'test',
  fixtures: 'test',
}

export const runtimeModules = {
  bun: ['bun', 'bun:', '@effect/platform-bun'],
  cloudflare: ['cloudflare:'],
  node: ['node:'],
} as const

export const runtimeAllows: Readonly<Record<Runtime, readonly (keyof typeof runtimeModules)[]>> = {
  cloud: ['cloudflare', 'node'],
  shared: ['node'],
  browser: [],
  daemon: ['bun', 'node'],
  test: ['cloudflare', 'node'],
  tooling: ['bun', 'cloudflare', 'node'],
}

export const nodes: readonly Node[] = [
  {
    dir: 'apps/api',
    name: '@sidequest/api',
    role: 'the hosted board API and MCP service.',
    runtime: 'cloud',
    mayImport: ['@sidequest/board', '@sidequest/commons', '@sidequest/indexer', '@sidequest/sdk'],
  },
  {
    dir: 'apps/indexer',
    name: '@sidequest/indexer-worker',
    role: 'the hosted chain indexer Worker.',
    runtime: 'cloud',
    mayImport: ['@sidequest/board', '@sidequest/indexer', '@sidequest/sdk'],
  },
  {
    dir: 'apps/explore',
    name: '@sidequest/explore',
    role: 'the browser marketplace and explorer.',
    runtime: 'browser',
    mayImport: ['@sidequest/react', '@sidequest/sdk'],
    // The asset-serving Worker runs in Cloudflare rather than the browser bundle.
    zones: { 'worker.ts': 'cloud' },
  },
  {
    dir: 'apps/arbiter',
    name: '@sidequest/arbiter',
    role: 'the arbitration daemon.',
    runtime: 'daemon',
    mayImport: ['@sidequest/board', '@sidequest/sdk'],
  },
  {
    dir: 'apps/docs',
    name: '@sidequest/docs',
    role: 'the documentation site.',
    runtime: 'browser',
    mayImport: ['@sidequest/sdk'],
  },
  {
    dir: 'packages/sdk',
    name: '@sidequest/sdk',
    role: 'the typed client and v1 flow library.',
    runtime: 'shared',
    mayImport: [],
  },
  {
    dir: 'packages/board',
    name: '@sidequest/board',
    role: 'board domain and persistence contracts.',
    runtime: 'shared',
    mayImport: ['@sidequest/sdk'],
  },
  {
    dir: 'packages/commons',
    name: '@sidequest/commons',
    role: 'public threads, gaps and stake-weighted roadmap.',
    runtime: 'shared',
    mayImport: ['@sidequest/sdk'],
  },
  {
    dir: 'packages/indexer',
    name: '@sidequest/indexer',
    role: 'indexing and notification domain logic.',
    runtime: 'shared',
    mayImport: ['@sidequest/board', '@sidequest/sdk'],
  },
  {
    dir: 'packages/react',
    name: '@sidequest/react',
    role: 'React hooks for the client.',
    runtime: 'shared',
    mayImport: ['@sidequest/sdk'],
    // Hook implementations run in the consuming browser bundle.
    zones: { src: 'browser' },
  },
  {
    dir: 'contracts',
    name: '@sidequest/contracts',
    role: 'Foundry contracts and scripts.',
    runtime: 'tooling',
    mayImport: [],
    seam: { consumer: 'forge and release scripts', reason: 'Contracts are compiled and tested by Foundry.' },
  },
  {
    dir: 'tools',
    name: 'tools',
    role: 'repository quality gates.',
    runtime: 'tooling',
    mayImport: [],
    seam: { consumer: 'root check scripts', reason: 'Quality tooling is invoked by root scripts and CI.' },
  },
]
