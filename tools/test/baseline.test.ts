import { describe, expect, test } from 'vitest'
import {
  compare,
  countFindings,
  inScope,
  parseBaseline,
  renderIncreases,
  renderStale,
  serializeBaseline,
  sourceOfRule,
  totals,
  updateBaseline,
} from '../baseline.ts'
import type { Baseline } from '../baseline.ts'
import type { Finding } from '../report.ts'

const at = (file: string, rule: string, line: number): Finding => ({
  source: sourceOfRule(rule),
  rule,
  file,
  line,
  fixable: false,
})

const A = 'apps/api/src/a.ts'
const B = 'apps/api/src/b.ts'
const ANY = 'typescript(no-explicit-any)'
const DATE = 'knip(files)'

const baseline: Baseline = { [A]: { [ANY]: 2, [DATE]: 1 }, [B]: { [ANY]: 1 } }
/** Exactly the baseline's findings. */
const recorded = [at(A, ANY, 3), at(A, ANY, 9), at(A, DATE, 4), at(B, ANY, 1)]

describe('compare', () => {
  test('findings equal to the baseline pass', () => {
    expect(compare(baseline, recorded)).toEqual({ increases: [], stale: [] })
  })

  test('a count above its baseline is an increase, with the lines of that rule in that file', () => {
    const { increases, stale } = compare(baseline, [...recorded, at(A, ANY, 20), at(A, DATE, 30)])
    expect(stale).toEqual([])
    expect(increases).toEqual([
      { file: A, rule: DATE, baseline: 1, actual: 2, lines: [4, 30] },
      { file: A, rule: ANY, baseline: 2, actual: 3, lines: [3, 9, 20] },
    ])
  })

  test('a file the baseline does not hold is an increase from 0', () => {
    const { increases } = compare(baseline, [...recorded, at('apps/api/src/c.ts', ANY, 5)])
    expect(increases).toEqual([{ file: 'apps/api/src/c.ts', rule: ANY, baseline: 0, actual: 1, lines: [5] }])
  })

  test('a rule the baseline does not hold for that file is an increase from 0', () => {
    const { increases } = compare(baseline, [...recorded, at(B, 'knip(exports)', 7)])
    expect(increases).toEqual([{ file: B, rule: 'knip(exports)', baseline: 0, actual: 1, lines: [7] }])
  })

  test('fewer findings than recorded is a stale entry', () => {
    const { increases, stale } = compare(baseline, [at(A, ANY, 3), at(A, DATE, 4), at(B, ANY, 1)])
    expect(increases).toEqual([])
    expect(stale).toEqual([{ file: A, rule: ANY, baseline: 2, actual: 1 }])
  })

  test('a deleted or clean file leaves every one of its entries stale', () => {
    const { stale } = compare(baseline, [at(B, ANY, 1)])
    expect(stale).toEqual([
      { file: A, rule: DATE, baseline: 1, actual: 0 },
      { file: A, rule: ANY, baseline: 2, actual: 0 },
    ])
  })

  test('an increase and a stale entry are reported together', () => {
    const { increases, stale } = compare(baseline, [at(A, ANY, 3), at(A, DATE, 4), at(A, DATE, 5), at(B, ANY, 1)])
    expect(increases.map(({ rule, actual }) => [rule, actual])).toEqual([[DATE, 2]])
    expect(stale.map(({ rule, actual }) => [rule, actual])).toEqual([[ANY, 1]])
  })
})

describe('updateBaseline', () => {
  test('lowers each entry to the current count and drops zero counts and empty files', () => {
    const result = updateBaseline(baseline, [at(A, ANY, 3)])
    expect(result).toEqual({ written: true, baseline: { [A]: { [ANY]: 1 } } })
  })

  test('unchanged findings give back the same baseline', () => {
    const result = updateBaseline(baseline, recorded)
    expect(result.written && serializeBaseline(result.baseline)).toBe(serializeBaseline(baseline))
  })

  test('refuses on any increase, even beside a fixed finding, and returns the increases', () => {
    const result = updateBaseline(baseline, [at(A, ANY, 3), at(A, DATE, 4), at(B, ANY, 1), at(B, ANY, 2)])
    expect(result).toEqual({
      written: false,
      increases: [{ file: B, rule: ANY, baseline: 1, actual: 2, lines: [1, 2] }],
    })
  })

  test('refuses on a new file', () => {
    expect(updateBaseline(baseline, [...recorded, at('scripts/new.ts', ANY, 1)]).written).toBe(false)
  })

  test('with paths, lowers only the entries of those files and directories', () => {
    expect(updateBaseline(baseline, [at(A, ANY, 3)], [B])).toEqual({
      written: true,
      baseline: { [A]: { [ANY]: 2, [DATE]: 1 } },
    })
    expect(updateBaseline(baseline, [at(A, ANY, 3)], ['apps/api/src'])).toEqual({
      written: true,
      baseline: { [A]: { [ANY]: 1 } },
    })
  })

  test('with paths, an increase elsewhere does not block it; one inside does', () => {
    const elsewhere = updateBaseline(baseline, [at(A, ANY, 3), at('scripts/new.ts', ANY, 1)], [A])
    expect(elsewhere).toEqual({ written: true, baseline: { [A]: { [ANY]: 1 }, [B]: { [ANY]: 1 } } })
    expect(updateBaseline(baseline, [...recorded, at(A, DATE, 8)], [A]).written).toBe(false)
  })
})

describe('inScope', () => {
  test('matches the file itself or a directory above it, never a name prefix', () => {
    expect(inScope(A, [])).toBe(true)
    expect(inScope(A, [A])).toBe(true)
    expect(inScope(A, ['apps/api'])).toBe(true)
    expect(inScope(A, ['apps/my'])).toBe(false)
    expect(inScope(A, [B])).toBe(false)
  })
})

describe('serializeBaseline', () => {
  test('sorts files and rules by code unit, indents by two spaces and ends with a newline', () => {
    const text = serializeBaseline({ 'b.ts': { 'z(x)': 1, 'a(x)': 2 }, 'B.ts': { 'k(y)': 3 }, 'a.ts': { 'm(x)': 4 } })
    expect(text).toBe(
      [
        '{',
        '  "B.ts": {',
        '    "k(y)": 3',
        '  },',
        '  "a.ts": {',
        '    "m(x)": 4',
        '  },',
        '  "b.ts": {',
        '    "a(x)": 2,',
        '    "z(x)": 1',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  })

  test('the same counts give the same text whatever order the findings came in', () => {
    const forward = serializeBaseline(countFindings(recorded))
    expect(serializeBaseline(countFindings(recorded.toReversed()))).toBe(forward)
    expect(forward).toBe(serializeBaseline(baseline))
  })

  test('an empty baseline is an empty object', () => {
    expect(serializeBaseline({})).toBe('{}\n')
  })

  test('parses back to the same baseline', () => {
    expect(parseBaseline(serializeBaseline(baseline))).toEqual(baseline)
  })
})

describe('parseBaseline', () => {
  test('rejects counts that are not positive integers', () => {
    expect(() => parseBaseline('{"a.ts": {"r(x)": 0}}')).toThrow()
    expect(() => parseBaseline('{"a.ts": {"r(x)": 1.5}}')).toThrow()
    expect(() => parseBaseline('{"a.ts": 3}')).toThrow()
    expect(() => parseBaseline('not json')).toThrow()
  })
})

describe('totals and rendering', () => {
  test('counts findings per gate from the rule prefix', () => {
    expect(totals({ ...baseline, [B]: { [ANY]: 1, 'knip(types)': 2, 'effect(processEnv)': 4 } })).toEqual({
      findings: 10,
      files: 2,
      bySource: { oxlint: 3, effect: 4, knip: 3 },
    })
    expect(sourceOfRule('effect(extendsNativeError)')).toBe('effect')
  })

  test('an increase line names the file, the rule, baseline → actual and the known lines', () => {
    expect(
      renderIncreases([
        { file: A, rule: ANY, baseline: 2, actual: 3, lines: [3, 9, 20] },
        { file: B, rule: DATE, baseline: 0, actual: 1, lines: [4] },
        { file: 'package.json', rule: 'knip(files)', baseline: 0, actual: 1, lines: [0] },
      ]),
    ).toEqual([
      `  ${A}  ${ANY}  2 → 3  (lines 3, 9, 20)`,
      `  ${B}  ${DATE}  0 → 1  (line 4)`,
      '  package.json  knip(files)  0 → 1',
    ])
    expect(renderStale([{ file: A, rule: ANY, baseline: 2, actual: 0 }])).toEqual([`  ${A}  ${ANY}  2 → 0`])
  })
})
