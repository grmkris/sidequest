import { describe, expect, it } from 'vitest'
import { presentationInputJsonSchema, presentationJsonSchema } from './catalog.ts'
import { normalizeOpenUI, normalizePresentation } from './openui.ts'
import { parsePresentation, readPresentation } from './validate.ts'

/** The exported free-text rule: the one pattern that is not an element ID or the HTTPS prefix. */
function extractTextPattern(json: string): string {
  const patterns = [...json.matchAll(/"pattern":"((?:[^"\\]|\\.)*)"/gu)].map((match) => JSON.parse(`"${match[1]}"`))
  const text = patterns.find((pattern: string) => pattern.startsWith('^[^\\u0000'))
  if (text === undefined) throw new Error('text pattern missing')
  return text
}

const plan = {
  protocol: 'sidequest.commons-ui',
  version: 1,
  spec: {
    root: 'plan',
    elements: {
      plan: {
        type: 'Plan',
        props: { title: 'Release plan', summary: 'A readable plan.' },
        children: ['steps', 'question'],
      },
      steps: {
        type: 'StepList',
        props: { title: 'Steps', items: [{ title: 'Review', detail: 'Read it', status: 'done' }] },
      },
      question: { type: 'AskQuestion', props: { question: 'Ready?', options: ['Yes', 'Not yet'] } },
    },
  },
} as const

describe('Commons presentation contract', () => {
  it('accepts a bounded tree and rejects orphaned or cyclic nodes', () => {
    expect(parsePresentation(plan)).toEqual(plan)
    expect(() =>
      parsePresentation({
        ...plan,
        spec: { ...plan.spec, elements: { ...plan.spec.elements, orphan: plan.spec.elements.steps } },
      }),
    ).toThrow('visible')
    expect(() =>
      parsePresentation({
        ...plan,
        spec: {
          root: 'plan',
          elements: { plan: { type: 'Plan', props: plan.spec.elements.plan.props, children: ['plan'] } },
        },
      }),
    ).toThrow('tree')
  })

  it('rejects unsafe evidence and table shape mismatches', () => {
    const evidence = {
      ...plan,
      spec: {
        root: 'plan',
        elements: {
          plan: { type: 'Plan', props: plan.spec.elements.plan.props, children: ['evidence'] },
          evidence: {
            type: 'Evidence',
            props: { title: 'Sources', items: [{ label: 'Bad', url: 'javascript:alert(1)', detail: 'No' }] },
          },
        },
      },
    }
    expect(() => parsePresentation(evidence)).toThrow()
    const table = {
      ...plan,
      spec: {
        root: 'plan',
        elements: {
          plan: { type: 'Plan', props: plan.spec.elements.plan.props, children: ['table'] },
          table: { type: 'DataTable', props: { title: 'Data', columns: ['A', 'B'], rows: [['only A']] } },
        },
      },
    }
    expect(() => parsePresentation(table)).toThrow('columns')
  })

  it('normalizes supported OpenUI into the same document and rejects executable features', () => {
    const normalized = normalizeOpenUI(
      'root = Plan("Release plan", "A readable plan.", [Callout("Note", "Review first", "note"), AskQuestion("Ready?", ["Yes", "Not yet"])])',
    )
    expect(normalized.protocol).toBe('sidequest.commons-ui')
    expect(Object.values(normalized.spec.elements).map((element) => element.type)).toEqual([
      'Callout',
      'AskQuestion',
      'Plan',
    ])
    expect(() => normalizeOpenUI('root = Plan("A", "B", [Query("list_messages")])')).toThrow(
      'Unknown Commons component',
    )
    expect(() =>
      normalizeOpenUI('root = Plan("A", "B", [Callout("A", "B", "note")])\nunused = Callout("U", "V", "note")'),
    ).toThrow('reachable')
  })

  it('turns malformed persisted data into the Markdown fallback', () => {
    expect(readPresentation({ protocol: 'sidequest.commons-ui', version: 99 })).toBeNull()
  })

  it.each([
    'root = Plan("A", "B", [Callout("A", "B", "note")]) trailing',
    'root = Plan("A", "B", [Callout("A", "B", "note")])\ngarbage',
    'root = Plan("A", "B", [Callout("A", "B", "note")])!',
    'root = Plan("A", "B", [Callout("A", "B", "note")])\nroot = Plan("C", "D", [])',
    'root = Plan("A", "B", [Callout("A", "B", "note")]',
    'root = Plan("A", "B", [Mutation("post_message", {})])',
    'root = Plan("A", "B", [DraftReply(@ToAssistant("hidden"))])',
    '$secret = "hidden"\nroot = Plan("A", "B", [DraftReply($secret)])',
    'root = Plan("A", "B", [missing])',
    'root = Plan("A", "B", [other])\nother = root',
    'root = Plan("A", "B", [Callout("A", "B", "note", "hidden")])',
    'root = Plan("A", "B", [Evidence("Links", [{label: "Link", url: "https://user:pass@example.com", detail: "Source"}])])',
  ])('rejects incomplete, hidden or executable OpenUI: %s', (source) => {
    expect(() => normalizeOpenUI(source)).toThrow()
  })

  it('bounds recursive data expansion before allocating a huge document', () => {
    const values = [
      'a = "x"',
      ...Array.from(
        { length: 15 },
        (_, i) =>
          `${String.fromCharCode(98 + i)} = [${Array(10)
            .fill(String.fromCharCode(97 + i))
            .join(',')}]`,
      ),
    ]
    expect(() => normalizeOpenUI(`root = Plan("A", "B", [DataTable("T", ["C"], p)])\n${values.join('\n')}`)).toThrow()
  })

  it('stops reference expansion at the size budget before building the document', () => {
    const table = 'root = Plan("A", "B", [DataTable("T", ["C"], c)])'
    const strings = `${table}\nc = [${Array(21).fill('b').join(',')}]\nb = [${Array(95).fill('a').join(',')}]\na = s\ns = "${'x'.repeat(30000)}"`
    const keys = `${table}\nc = [${Array(21).fill('b').join(',')}]\nb = [${Array(48).fill('a').join(',')}]\na = {k${'x'.repeat(29000)}: s}\ns = "v"`
    for (const source of [strings, keys]) expect(() => normalizeOpenUI(source)).toThrow('expands beyond the 32 KiB')
  })

  it('accepts a document that reuses one statement within the size budget', () => {
    const detail = 'd'.repeat(1800)
    const source = [
      'root = Plan("Plan", "Summary", [steps])',
      `steps = StepList("Steps", [${Array(10).fill('step').join(',')}])`,
      'step = {title: "Same step", detail: text, status: "planned"}',
      `text = "${detail}"`,
    ].join('\n')
    const document = normalizeOpenUI(source)
    expect(Object.keys(document.spec.elements)).toHaveLength(2)
  })

  it('collapses blank-line runs so nothing hides below the visible text', () => {
    const padded = normalizePresentation({
      ...plan,
      spec: {
        root: 'plan',
        elements: { ...plan.spec.elements, question: { type: 'DraftReply', props: { text: 'Hi\n\n\n \n\t\nthere' } } },
      },
    })
    expect(padded.spec.elements.question).toEqual({ type: 'DraftReply', props: { text: 'Hi\n\nthere' } })
  })

  it('exports tool schemas that strict and non-ECMAScript validators accept', () => {
    const json = JSON.stringify([presentationJsonSchema, presentationInputJsonSchema])
    expect(json).not.toContain('$schema')
    expect(json).not.toContain('starts_with')
    expect(json).not.toContain('\\\\p{')
    const pattern = new RegExp(extractTextPattern(json))
    for (const [sample, ok] of [
      ['Plain text\n\twith tabs', true],
      ['zero​width', false],
      ['bidi‮override', false],
      ['bell\u0007', false],
    ] as const)
      expect(pattern.test(sample)).toBe(ok)
  })

  it('rejects unknown properties, handlers, versions, and oversized documents', () => {
    expect(() => parsePresentation({ ...plan, version: 2 })).toThrow()
    expect(() => parsePresentation({ ...plan, onLoad: 'post_message' })).toThrow()
    expect(() =>
      parsePresentation({
        ...plan,
        spec: {
          ...plan.spec,
          elements: {
            ...plan.spec.elements,
            question: { ...plan.spec.elements.question, on: { click: { action: 'post_message' } } },
          },
        },
      }),
    ).toThrow()
    expect(() => parsePresentation({ ...plan, extra: 'x'.repeat(32768) })).toThrow('32 KiB')
  })
})
