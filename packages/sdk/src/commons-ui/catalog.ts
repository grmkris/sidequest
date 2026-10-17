import { z } from 'zod'

/** At most one blank line in a row (whitespace-only lines count), as in message bodies: no padding can hide text. */
const collapseBlankLines = (value: string) => value.replace(/\n(?:[ \t]*\n){2,}/gu, '\n\n')
const TEXT_RULE = /^(?:[^\p{Cc}\p{Cf}]|\n|\t)*$/u
const text = (max: number) => z.string().overwrite(collapseBlankLines).min(1).max(max).regex(TEXT_RULE)
const title = text(160)
const detail = text(2000)
const items = <T extends z.ZodType>(schema: T) => z.array(schema).min(1).max(24)
export const elementId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u)
const state = z.enum(['planned', 'active', 'done', 'blocked'])

/** Property order is also the positional OpenUI signature. No arbitrary handlers, styles or hidden action payloads. */
export const componentProps = {
  Plan: z.strictObject({ title, summary: detail }),
  StepList: z.strictObject({ title, items: items(z.strictObject({ title, detail, status: state })) }),
  Decision: z.strictObject({ title, options: items(z.strictObject({ label: title, detail })) }),
  Evidence: z.strictObject({
    title,
    items: items(z.strictObject({ label: title, url: z.url().startsWith('https://').max(2048), detail })),
  }),
  Timeline: z.strictObject({ title, items: items(z.strictObject({ when: text(80), title, detail })) }),
  DataTable: z.strictObject({
    title,
    columns: z.array(title).min(1).max(8),
    rows: z.array(z.array(text(400)).max(8)).max(50),
  }),
  Callout: z.strictObject({ title, text: detail, tone: z.enum(['note', 'risk', 'success']) }),
  AskQuestion: z.strictObject({ question: title, options: items(title) }),
  RiskMatrix: z.strictObject({
    title,
    items: items(
      z.strictObject({
        risk: title,
        likelihood: z.enum(['low', 'medium', 'high']),
        impact: z.enum(['low', 'medium', 'high']),
        mitigation: detail,
      }),
    ),
  }),
  DraftReply: z.strictObject({ text: detail }),
}

export type ComponentName = keyof typeof componentProps
export type ComponentProps<K extends ComponentName> = z.infer<(typeof componentProps)[K]>
const leaf = <K extends ComponentName>(type: K) =>
  z.strictObject({ type: z.literal(type), props: componentProps[type] })
export const elementSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Plan'), props: componentProps.Plan, children: z.array(elementId).min(1).max(24) }),
  leaf('StepList'),
  leaf('Decision'),
  leaf('Evidence'),
  leaf('Timeline'),
  leaf('DataTable'),
  leaf('Callout'),
  leaf('AskQuestion'),
  leaf('RiskMatrix'),
  leaf('DraftReply'),
])

export const presentationSchema = z.strictObject({
  protocol: z.literal('sidequest.commons-ui'),
  version: z.literal(1),
  spec: z.strictObject({ root: elementId, elements: z.record(elementId, elementSchema) }),
})
export type Presentation = z.infer<typeof presentationSchema>
export type PresentationElement = z.infer<typeof elementSchema>

/** Cc and BMP Cf code points except tab and newline: `text`'s rule without `\p{…}`, which Python `re` rejects. */
const DISALLOWED_TEXT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
]
const escape = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`
const PORTABLE_TEXT_PATTERN = `^[^${DISALLOWED_TEXT_RANGES.map(([from, to]) => (from === to ? escape(from) : `${escape(from)}-${escape(to)}`)).join('')}]*$`

type JsonSchema = z.core.JSONSchema.BaseSchema

/**
 * MCP hosts compile tool schemas with strict or non-ECMAScript validators. Export only portable keywords: no nested
 * `$schema`, no zod-only `format: starts_with` (the HTTPS pattern stays), no Unicode property escapes. zod still
 * enforces the exact rules on every write and read.
 */
function portable(schema: JsonSchema): JsonSchema {
  return JSON.parse(
    JSON.stringify(schema, (key, value) => {
      if (key === '$schema' || (key === 'format' && value === 'starts_with')) return undefined
      return key === 'pattern' && value === TEXT_RULE.source ? PORTABLE_TEXT_PATTERN : value
    }),
  )
}
export const presentationJsonSchema = portable(z.toJSONSchema(presentationSchema, { target: 'draft-7' }))
export const openuiInputSchema = z.strictObject({
  protocol: z.literal('openui'),
  version: z.literal(1),
  source: z.string().min(1).max(32768),
})
export const presentationInputJsonSchema = portable(
  z.toJSONSchema(z.union([presentationSchema, openuiInputSchema]), { target: 'draft-7' }),
)

export const componentDescriptions: Record<ComponentName, string> = {
  Plan: 'A plan title, summary and ordered child components. The root must be Plan.',
  StepList: 'Authored step status and expandable details. Reading a step never changes its saved status.',
  Decision: 'Options and tradeoffs. Selection is local; a reader can prepare a visible reply.',
  Evidence: 'HTTPS evidence links with visible source URLs and descriptions. No automatic fetching.',
  Timeline: 'An authored sequence of milestones, with human-readable dates or relative times.',
  DataTable: 'A bounded table with local text filtering.',
  Callout: 'A note, risk or success observation supplied by the author, not verified by Sidequest.',
  AskQuestion: 'Select a visible answer and prepare a reply. Nothing posts until the reader submits the composer.',
  RiskMatrix: 'Authored likelihood, impact and mitigation. No calculated authority or live risk rating.',
  DraftReply: 'Visible suggested reply text. The reader can copy it into their draft, then edit and submit.',
}
