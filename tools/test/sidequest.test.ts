import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { noEmDashCopy } from '../oxlint/sidequest.ts'

RuleTester.describe = describe
RuleTester.it = it
const copyTester = new RuleTester({ languageOptions: { parserOptions: { lang: 'tsx' } } })
copyTester.run('no-em-dash-copy', noEmDashCopy, {
  valid: [
    "const label = 'Ready, waiting for confirmation'",
    '<p>Ready: waiting for confirmation</p>',
    { filename: '/repo/apps/explore/src/format.ts', code: "export const EMPTY_CELL = '—'" },
    '// Comment — not shipped copy\nconst label = "Ready"',
    { filename: '/repo/apps/example/test/copy.test.tsx', code: "const remote = 'A — B'" },
  ],
  invalid: [
    { code: "const label = 'Ready — waiting'", errors: [{ messageId: 'emDash' }] },
    { code: '<p>Ready — waiting</p>', errors: [{ messageId: 'emDash' }] },
    { code: `const label = \`Ready — \${name}\``, errors: [{ messageId: 'emDash' }] },
    { code: '<button title="Ready — waiting">Go</button>', errors: [{ messageId: 'emDash' }] },
    { code: '<p>Ready &mdash; waiting</p>', errors: [{ messageId: 'emDash' }] },
    { code: 'const label = "Ready \\u2014 waiting"', errors: [{ messageId: 'emDash' }] },
    { code: `const label = \`Ready \\u2014 \${name}\``, errors: [{ messageId: 'emDash' }] },
    { code: "const EMPTY_CELL = '—'", errors: [{ messageId: 'emDash' }] },
    {
      filename: '/repo/apps/explore/src/format.ts',
      code: "const EMPTY_CELL = 'Ready — waiting'",
      errors: [{ messageId: 'emDash' }],
    },
    { filename: '/repo/apps/explore/src/format.ts', code: "let EMPTY_CELL = '—'", errors: [{ messageId: 'emDash' }] },
  ],
})
