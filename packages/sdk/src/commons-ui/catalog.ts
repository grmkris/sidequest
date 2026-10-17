import { z } from 'zod'

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^(?:[^\p{Cc}\p{Cf}]|\n|\t)*$/u)
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
export const presentationJsonSchema = z.toJSONSchema(presentationSchema, { target: 'draft-7' })
export const openuiInputSchema = z.strictObject({
  protocol: z.literal('openui'),
  version: z.literal(1),
  source: z.string().min(1).max(32768),
})
export const presentationInputJsonSchema = z.toJSONSchema(z.union([presentationSchema, openuiInputSchema]), {
  target: 'draft-7',
})

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
