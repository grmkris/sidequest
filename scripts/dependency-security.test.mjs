import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const decode = require('decode-uri-component')

await test('wallet URI decoder retains CommonJS, plus, Unicode and malformed-input compatibility', () => {
  for (const [encoded, expected] of [
    ['hello+world%2B', 'hello world+'],
    ['%C3%A5%F0%9F%98%80', 'å😀'],
    ['%FF%41%C3%A5', '%FFAå'],
    ['%FE%FF', '��'],
    ['%C2', '�'],
    ['%G0%25%252B', '%G0%%2B'],
    ['%ED%A0%80%41', '%ED%A0%80A'],
    ['%F4%90%80%80%41', '%F4%90%80%80A'],
  ]) {
    assert.equal(decode(encoded), expected)
  }
  assert.throws(() => decode(null), TypeError)
})

await test('malformed percent runs finish without recursive decoding or stack exhaustion', () => {
  // A child process gives a regressed synchronous decoder a hard deadline without hanging CI.
  execFileSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
const decode = require(process.argv[1]);
assert.equal(decode('%FF%41'.repeat(20000)), '%FFA'.repeat(20000));`,
      require.resolve('decode-uri-component'),
    ],
    { timeout: 5000, stdio: 'pipe' },
  )
})
