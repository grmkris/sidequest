import { autoClose, parseExpression, split, tokenize, type ASTNode } from '@openuidev/lang-core'
import { componentProps, elementId, openuiInputSchema, type Presentation } from './catalog.ts'
import { assertSize, parsePresentation, PRESENTATION_MAX_BYTES, PRESENTATION_MAX_NODES } from './validate.ts'

/** Strict lexical envelope around the streaming-tolerant upstream parser. Comments and executable expressions are not v1. */
function lex(source: string): string[] {
  // oxlint-disable-next-line no-control-regex -- JSON strings must reject raw control characters before the recovery parser.
  const token = /\s+|"(?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\u0000-\u001f])*"|[A-Za-z][A-Za-z0-9_]*|[=()[\]{},:]/uy
  const tokens: string[] = []
  let position = 0
  let depth = 0
  while (position < source.length) {
    token.lastIndex = position
    const match = token.exec(source)
    if (match === null)
      throw new Error('OpenUI v1 accepts only complete component calls, references, strings, arrays and objects')
    const value = match[0]
    position = token.lastIndex
    if (/^\s/u.test(value)) continue
    if ('([{'.includes(value) && ++depth > 12) throw new Error('OpenUI nesting is too deep')
    if (')]}'.includes(value) && --depth < 0) throw new Error('Unbalanced OpenUI expression')
    tokens.push(value.startsWith('"') ? JSON.stringify(JSON.parse(value)) : value)
  }
  if (depth !== 0) throw new Error('Incomplete OpenUI expression')
  return tokens
}

/** Re-serialize every accepted AST token; upstream recovery must never silently discard input. */
type StaticNode = Extract<ASTNode, { k: 'Str' | 'Ref' | 'Arr' | 'Obj' | 'Comp' }>
type OpenValue = string | OpenValue[] | { [key: string]: OpenValue }
function staticNode(node: ASTNode): StaticNode {
  if (node.k === 'Str' || node.k === 'Ref' || node.k === 'Arr' || node.k === 'Obj' || node.k === 'Comp') return node
  throw new Error('OpenUI expressions, actions and live data are not supported in Commons v1')
}
function serialize(input: ASTNode): string {
  const node = staticNode(input)
  switch (node.k) {
    case 'Str':
      return JSON.stringify(node.v)
    case 'Ref':
      return node.n
    case 'Arr':
      return `[${node.els.map(serialize).join(',')}]`
    case 'Obj':
      return `{${node.entries.map(([key, value]) => `${key}:${serialize(value)}`).join(',')}}`
    case 'Comp':
      if (node.fn === true) throw new Error('OpenUI functions are not supported')
      return `${node.name}(${node.args.map(serialize).join(',')})`
  }
}

/** Official OpenUI AST parser, restricted to the Commons catalog. Local interactions survive in component semantics. */
export function normalizeOpenUI(source: string): Presentation {
  assertSize(source)
  const tokens = lex(source)
  if (autoClose(source).wasIncomplete) throw new Error('OpenUI must be complete before posting')
  const statements = split(tokenize(source))
  if (statements.length === 0 || statements.length > 64) throw new Error('OpenUI requires 1–64 statements')
  const asts = new Map<string, ASTNode>()
  for (const statement of statements) {
    if (!elementId.safeParse(statement.id).success || asts.has(statement.id))
      throw new Error('OpenUI statement names must be unique lowercase IDs')
    asts.set(statement.id, parseExpression(statement.tokens))
  }
  const canonical = [...asts].map(([id, ast]) => `${id}=${serialize(ast)}`).join('\n')
  if (JSON.stringify(lex(canonical)) !== JSON.stringify(tokens))
    throw new Error('OpenUI contains unsupported or discarded syntax')
  const used = new Set<string>()
  const resolving = new Set<string>()
  const elements: Record<string, unknown> = {}
  let nodes = 0
  let evaluations = 0
  // A reference re-expands its statement each time, so a small source can name the same text thousands of times.
  // Every evaluated string and object key lands in the document: their sum bounds its size before it is built.
  let bytes = 0
  const encoder = new TextEncoder()
  const spend = (text: string) => {
    bytes += encoder.encode(text).length
    if (bytes > PRESENTATION_MAX_BYTES) throw new Error('OpenUI expands beyond the 32 KiB presentation limit')
  }
  const reference = (id: string): OpenValue => {
    const ast = asts.get(id)
    if (ast === undefined || resolving.has(id) || resolving.size >= 12)
      throw new Error('OpenUI has a missing, cyclic or too deeply nested reference')
    used.add(id)
    resolving.add(id)
    const value = evaluate(ast)
    resolving.delete(id)
    return value
  }
  const evaluate = (input: ASTNode): OpenValue => {
    const ast = staticNode(input)
    if (++evaluations > 4096) throw new Error('OpenUI expansion exceeds the document limit')
    switch (ast.k) {
      case 'Str':
        spend(ast.v)
        return ast.v
      case 'Ref':
        return reference(ast.n)
      case 'Arr':
        return ast.els.map(evaluate)
      case 'Obj': {
        const keys = ast.entries.map(([key]) => key)
        if (
          keys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)) ||
          new Set(keys).size !== keys.length
        )
          throw new Error('OpenUI object keys must be safe and unique')
        for (const key of keys) spend(key)
        return Object.fromEntries(ast.entries.map(([key, value]) => [key, evaluate(value)]))
      }
      case 'Comp': {
        if (!Object.hasOwn(componentProps, ast.name)) throw new Error(`Unknown Commons component: ${ast.name}`)
        // SAFETY: own-key check above narrows the finite catalog name.
        const name = ast.name as keyof typeof componentProps
        const keys = Object.keys(componentProps[name].shape)
        if (name === 'Plan') keys.push('children')
        if (keys.length !== ast.args.length) throw new Error(`${name} requires ${keys.join(', ')}`)
        if (++nodes > PRESENTATION_MAX_NODES) throw new Error('Too many OpenUI components')
        const id = `node${nodes}`
        const props = Object.fromEntries(keys.map((key, index) => [key, evaluate(ast.args[index]!)]))
        if (name === 'Plan') {
          const { children, ...planProps } = props
          elements[id] = { type: name, props: planProps, children }
        } else elements[id] = { type: name, props }
        return id
      }
    }
  }
  const root = reference('root')
  if (used.size !== asts.size) throw new Error('Every OpenUI statement must be reachable from root')
  return parsePresentation({ protocol: 'sidequest.commons-ui', version: 1, spec: { root, elements } })
}

export function normalizePresentation(value: unknown): Presentation {
  assertSize(value)
  const openui = openuiInputSchema.safeParse(value)
  return openui.success ? normalizeOpenUI(openui.data.source) : parsePresentation(value)
}
