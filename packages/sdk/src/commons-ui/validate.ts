import { presentationSchema, type Presentation, type PresentationElement } from './catalog.ts'

export const PRESENTATION_MAX_BYTES = 32768
export const PRESENTATION_MAX_NODES = 32
export const PRESENTATION_MAX_DEPTH = 4
const reserved = new Set(['constructor', 'prototype', '__proto__'])

export function assertSize(value: unknown): void {
  const json = JSON.stringify(value)
  if (json === undefined || new TextEncoder().encode(json).length > PRESENTATION_MAX_BYTES)
    throw new Error('Presentation must be at most 32 KiB')
}

/**
 * Documents returned by parsePresentation: encoding a message re-checks its presentation, and a thread page of
 * 32 KiB attachments would otherwise parse each twice. Callers never mutate a returned document.
 */
const validated = new WeakSet<object>()

/** The only document accepted by persistence and renderers. Reject unreachable/duplicated nodes as well as cycles. */
export function parsePresentation(value: unknown): Presentation {
  assertSize(value)
  const parsed = presentationSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Invalid presentation: ${parsed.error.issues[0]?.path.join('.') ?? 'document'}`)
  const document = parsed.data
  const { root, elements } = document.spec
  const ids = Object.keys(elements)
  if (ids.length > PRESENTATION_MAX_NODES || ids.some((id) => reserved.has(id)))
    throw new Error('Invalid presentation element IDs or count')
  if (!Object.hasOwn(elements, root) || elements[root]?.type !== 'Plan')
    throw new Error('Presentation root must be a Plan')
  const visited = new Set<string>()
  const visit = (id: string, depth: number): void => {
    if (depth > PRESENTATION_MAX_DEPTH || visited.has(id))
      throw new Error('Presentation must be a tree at most four levels deep')
    if (!Object.hasOwn(elements, id)) throw new Error(`Missing presentation element: ${id}`)
    const element = elements[id]!
    visited.add(id)
    if (element.type === 'Plan') for (const child of element.children) visit(child, depth + 1)
    validateElement(element)
  }
  visit(root, 1)
  if (visited.size !== ids.length) throw new Error('Every presentation element must be visible from the root')
  validated.add(document)
  return document
}

export function isPresentation(value: unknown): boolean {
  return (value instanceof Object && validated.has(value)) || readPresentation(value) !== null
}

/** Reading old/unknown/corrupt attachments must never prevent the Markdown body from being read. */
export function readPresentation(value: unknown): Presentation | null {
  try {
    return parsePresentation(value)
  } catch {
    return null
  }
}

function validateElement(element: PresentationElement): void {
  if (element.type === 'DataTable' && element.props.rows.some((row) => row.length !== element.props.columns.length))
    throw new Error('Table rows must match the columns')
  if (element.type === 'Evidence')
    for (const item of element.props.items) {
      const url = new URL(item.url)
      if (url.username !== '' || url.password !== '') throw new Error('Evidence URLs cannot contain credentials')
    }
  if (element.type === 'AskQuestion' && new Set(element.props.options).size !== element.props.options.length)
    throw new Error('Question options must be distinct')
  if (
    element.type === 'Decision' &&
    new Set(element.props.options.map((option) => option.label)).size !== element.props.options.length
  )
    throw new Error('Decision labels must be distinct')
}
