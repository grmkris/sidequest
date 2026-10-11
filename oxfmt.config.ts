import { defineConfig } from 'oxfmt'
import { agentIgnorePatterns } from './tools/vendored.ts'

export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 120,
  ignorePatterns: [
    'contracts/**',
    'docs/**',
    'skill/**',
    '**/generated/**',
    'packages/sdk/src/abi/**',
    '**/__snapshots__/**',
    'bun.lock',
    // Vendored from dmmulroy/anti-slop in upstream style (tools/oxlint/anti-slop/PROVENANCE.md).
    'tools/oxlint/anti-slop/**',
    // vendored skills, harness dirs, generated MCP files (tools/vendored.ts)
    ...agentIgnorePatterns(),
    '**/.alchemy/**',
    '**/dist/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/.source/**',
    '**/routeTree.gen.ts',
  ],
})
