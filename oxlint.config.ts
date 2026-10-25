import { defineConfig } from 'oxlint'
import { agentIgnorePatterns } from './tools/vendored.ts'

/**
 * Monorepo lint rules, all at error. Repository plugins add what generic rules cannot know:
 * - `boundaries` (tools/oxlint/boundaries.ts) enforces tools/graph.ts: declared workspace imports, and runtime-bound
 *   modules (`bun`, `bun:*`, `@effect/platform-bun`, `cloudflare:*`, `node:*`, the `Bun` global) only where the file's
 *   runtime allows them. It replaces the per-directory Bun and `cloudflare:workers` bans.
 * - `sidequest` (tools/oxlint/sidequest.ts) enforces repository invariants from AGENTS.md.
 * Relaxations are targeted overrides, each with its reason (tools/lint-baseline.json).
 */
export default defineConfig({
  ignorePatterns: [
    '**/.alchemy/**',
    '**/dist/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/.source/**',
    '**/.nitro/**',
    '**/routeTree.gen.ts',
    'contracts/lib/**',
    'contracts/out/**',
    'contracts/cache/**',
    // Vendored from dmmulroy/anti-slop (tools/oxlint/anti-slop/PROVENANCE.md): upstream code, upstream style.
    'tools/oxlint/anti-slop/**',
    // vendored skills, harness dirs, generated MCP files (tools/vendored.ts)
    ...agentIgnorePatterns(),
  ],
  // Type-aware rules run through oxlint-tsgolint, pinned with TypeScript (the root catalog). A bare `oxlint`
  // therefore matches CI. `--type-check` is never used: it picks the wrong tsconfig in workspaces with several.
  options: { typeAware: true, reportUnusedDisableDirectives: 'error' },
  jsPlugins: [
    './tools/oxlint/boundaries.ts',
    './tools/oxlint/sidequest.ts',
    './tools/oxlint/anti-slop/index.ts',
    './tools/oxlint/anti-slop/effect/index.ts',
    // Cognitive complexity (Sonar's metric); oxlint has no native rule for it.
    'oxlint-plugin-complexity',
  ],
  categories: { correctness: 'error', suspicious: 'error' },
  plugins: ['typescript', 'unicorn', 'oxc', 'import'],
  env: { es2024: true },
  rules: {
    'import/no-unassigned-import': 'off',
    'typescript/no-explicit-any': 'error',
    'no-underscore-dangle': 'off',
    'no-unused-vars': [
      'error',
      { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    // Type-aware rules beyond the categories (the categories already enable await-thenable, no-floating-promises,
    // no-base-to-string, no-misused-spread, restrict-template-expressions, unbound-method,
    // no-unnecessary-type-assertion and the rest of their type-aware rules).
    'typescript/no-misused-promises': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/only-throw-error': [
      'error',
      { allow: [{ from: 'package', name: ['Redirect', 'NotFoundError'], package: '@tanstack/router-core' }] },
    ],
    'typescript/no-deprecated': 'error',
    'typescript/ban-ts-comment': [
      'error',
      { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
    ],
    // Replaced by anti-slop's SAFETY-comment rule: an assertion is allowed when it states its invariant.
    'typescript/no-unsafe-type-assertion': 'off',
    // Off: it flags Effect's `return yield* Effect.fail(...)` (which Effect's missingReturnYieldStar diagnostic
    // requires), exhaustive switches, `process.exit` and React effect cleanups. TypeScript reports a missing return
    // value on its own.
    'typescript/consistent-return': 'off',
    // anti-slop (vendored, tools/oxlint/anti-slop/PROVENANCE.md). Not enabled: require-readable-spacing (the
    // formatter's job) and no-conditional-empty-object-spread (`...(c ? {} : { k })` is how optional properties are
    // written under exactOptionalPropertyTypes).
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-runtime-typeof': ['error', { allowInTypeGuards: true }],
    'anti-slop-effect/no-manual-tag-comparison': 'error',
    'anti-slop-effect/no-manual-effect-error-tag': 'error',
    'anti-slop-effect/prefer-effect-match': 'error',
    // Size and complexity: a file, a function or a nesting level an agent can hold in one read.
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    'max-depth': ['error', 4],
    'max-params': ['error', 5],
    'complexity/complexity': ['error', { cyclomatic: 1000, cognitive: 15 }],
    'boundaries/no-cross-boundary-import': 'error',
    'boundaries/no-runtime-global': 'error',
    'sidequest/require-disable-description': 'error',
  },
  overrides: [
    // Shipped UI, agent tool descriptions and error copy. Tests may carry arbitrary remote text.
    {
      files: ['apps/*/src/**', 'packages/*/src/**', 'packages/ui/gallery/**'],
      rules: { 'sidequest/no-em-dash-copy': 'error' },
    },
    // Explicit rule names are required: override plugins do not inherit category rules.
    {
      files: ['apps/explore/**', 'packages/react/**'],
      plugins: ['typescript', 'unicorn', 'oxc', 'import', 'react', 'jsx-a11y'],
      rules: {
        'react/react-in-jsx-scope': 'off',
        'react/rules-of-hooks': 'error',
        'jsx-a11y/alt-text': 'error',
        'jsx-a11y/anchor-has-content': 'error',
        'jsx-a11y/anchor-is-valid': 'error',
        'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
        'jsx-a11y/aria-props': 'error',
        'jsx-a11y/aria-proptypes': 'error',
        'jsx-a11y/aria-role': 'error',
        'jsx-a11y/aria-unsupported-elements': 'error',
        'jsx-a11y/autocomplete-valid': 'error',
        'jsx-a11y/click-events-have-key-events': 'error',
        'jsx-a11y/control-has-associated-label': 'error',
        'jsx-a11y/heading-has-content': 'error',
        'jsx-a11y/html-has-lang': 'error',
        'jsx-a11y/iframe-has-title': 'error',
        'jsx-a11y/img-redundant-alt': 'error',
        'jsx-a11y/interactive-supports-focus': 'error',
        'jsx-a11y/label-has-associated-control': 'error',
        'jsx-a11y/lang': 'error',
        'jsx-a11y/media-has-caption': 'error',
        'jsx-a11y/mouse-events-have-key-events': 'error',
        'jsx-a11y/no-access-key': 'error',
        'jsx-a11y/no-aria-hidden-on-focusable': 'error',
        'jsx-a11y/no-autofocus': 'error',
        'jsx-a11y/no-distracting-elements': 'error',
        'jsx-a11y/no-interactive-element-to-noninteractive-role': 'error',
        'jsx-a11y/no-noninteractive-element-interactions': 'error',
        'jsx-a11y/no-noninteractive-element-to-interactive-role': 'error',
        'jsx-a11y/no-noninteractive-tabindex': 'error',
        'jsx-a11y/no-redundant-roles': 'error',
        'jsx-a11y/no-static-element-interactions': 'error',
        'jsx-a11y/prefer-tag-over-role': 'error',
        'jsx-a11y/role-has-required-aria-props': 'error',
        'jsx-a11y/role-supports-aria-props': 'error',
        'jsx-a11y/scope': 'error',
        'jsx-a11y/tabindex-no-positive': 'error',
      },
    },
    // `any` is banned in shipped code (src, app, entrypoints). Tests, fixtures and one-shot tooling (scripts, deploy)
    // poke at untyped JSON, provider responses and mocks, where `any` is the honest type.
    {
      files: [
        '**/test/**',
        '**/tests/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        'apps/*/scripts/**',
        'apps/*/deploy/**',
        'apps/*/fixtures/**',
      ],
      rules: { 'typescript/no-explicit-any': 'off' },
    },
    // Test files: a `describe` block is the file's outline, not a function to split, and table-driven suites run
    // long. They still have a size limit.
    {
      files: ['**/test/**', '**/tests/**', '**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'max-lines-per-function': 'off',
        'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
      },
    },
  ],
})
