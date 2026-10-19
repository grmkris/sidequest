/**
 * Runtime check of every tool call against the input schema it publishes, for REST (`POST /api/<tool>`), hosted MCP
 * and the board Durable Object alike. Before this, schemas were only advertised: a JSON number sent where a string was
 * declared reached a handler's `as string` cast and was stored as "10415.0".
 *
 * Coercion is deliberately narrow: a JSON integer in the safe range becomes its decimal string where the schema says
 * string (and not number or integer). Nothing else is coerced. Envelope keys (operationKey, managedAgentId,
 * idempotencyKey) pass through unchecked: the transports and the hosted runtime own them.
 *
 * `enforce` refuses an invalid call with code invalid and the failing field path; `log` (production default until the
 * would-refuse rate is known) logs the same finding and runs the call with the coerced arguments.
 */
import { Validator, type OutputUnit, type Schema } from '@cfworker/json-schema'
import { AgentFailure } from '@sidequest/board'

export type ToolArgsMode = 'enforce' | 'log'

/** Keys the transports add around a tool's own arguments; never checked here, always passed through. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['operationKey', 'managedAgentId', 'idempotencyKey'])

type Args = Record<string, unknown>

const isRecord = (value: unknown): value is Args => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number'

/**
 * The mode for this runtime: an explicit `TOOL_ARGS_MODE` of enforce or log wins; otherwise production (the prod
 * stage or Monad mainnet) logs and every other stage, local Worker and test enforces.
 */
export function toolArgsMode(bindings: Args): ToolArgsMode {
  const explicit = bindings.TOOL_ARGS_MODE
  if (explicit === 'enforce' || explicit === 'log') return explicit
  return bindings.DEPLOY_STAGE === 'prod' || bindings.NETWORK === 'monad-mainnet' ? 'log' : 'enforce'
}

/** A refused call: code invalid, the JSON path of the first failing field, and no retry with the same arguments. */
export class ToolArgsError extends AgentFailure {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super('invalid', message, 'invalid-arguments', 'none')
  }
}

const validators = new WeakMap<object, Validator>()

/** A validator over a private copy of the schema without envelope keys; the published schema is never annotated. */
function validatorFor(schema: object): Validator {
  const cached = validators.get(schema)
  if (cached !== undefined) return cached
  // SAFETY: every tool inputSchema is a JSON Schema object literal; structuredClone keeps that shape.
  const clone = structuredClone(schema) as Schema
  // The hosted runtime requires operationKey itself, so a schema that lists it (setup_status) never refuses here.
  if (clone.properties !== undefined) for (const key of ENVELOPE_KEYS) delete clone.properties[key]
  if (clone.required !== undefined) clone.required = clone.required.filter((key) => !ENVELOPE_KEYS.has(key))
  const validator = new Validator(clone, '2020-12', false)
  validators.set(schema, validator)
  return validator
}

/** The JSON types a schema node allows. */
function typesOf(schema: Args): readonly string[] {
  if (isText(schema.type)) return [schema.type]
  return Array.isArray(schema.type) ? schema.type.filter(isText) : []
}

/** Paths found while coercing: integers turned into strings, and numbers left alone because they were not safe. */
interface Coercion {
  readonly coerced: string[]
  readonly refused: Set<string>
}

const join = (path: string, key: string) => (path === '' ? key : `${path}.${key}`)

/** Coerces `holder[key]` in place against its schema node, recursing into declared properties and array items. */
function coerceAt(schema: unknown, holder: Args | unknown[], key: string | number, path: string, found: Coercion) {
  if (!isRecord(schema)) return
  // SAFETY: key indexes this holder (a property name of a record or an index of an array), for reading and writing.
  const target = holder as Args
  const value = target[key]
  const allowed = typesOf(schema)
  if (isNumber(value)) {
    if (!allowed.includes('string') || allowed.includes('number') || allowed.includes('integer')) return
    if (!Number.isSafeInteger(value)) return void found.refused.add(path)
    target[key] = String(value)
    return void found.coerced.push(path)
  }
  if (isRecord(value) && isRecord(schema.properties)) coerceObject(schema.properties, value, path, found)
  if (Array.isArray(value)) value.forEach((_, i) => coerceAt(schema.items, value, i, `${path}[${i}]`, found))
}

function coerceObject(properties: Args, value: Args, path: string, found: Coercion) {
  for (const key of Object.keys(properties))
    if (Object.hasOwn(value, key)) coerceAt(properties[key], value, key, join(path, key), found)
}

/** `#/invite/agentId` and `#/tags/0` as `invite.agentId` and `tags[0]`. */
function fieldPath(instanceLocation: string): string {
  let path = ''
  for (const raw of instanceLocation.replace(/^#\/?/, '').split('/')) {
    if (raw === '') continue
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    path = /^\d+$/.test(part) ? `${path}[${part}]` : join(path, part)
  }
  return path
}

/** The most specific error: the deepest instance location, then the deepest keyword. */
const deeper = (best: OutputUnit, e: OutputUnit) =>
  e.instanceLocation.length > best.instanceLocation.length ||
  (e.instanceLocation.length === best.instanceLocation.length && e.keywordLocation.length > best.keywordLocation.length)
    ? e
    : best

export type ToolArgsCheck =
  | { readonly ok: true; readonly args: Args; readonly coerced: readonly string[] }
  | { readonly ok: false; readonly error: ToolArgsError; readonly args: Args }

/** Coerces (on a copy) and validates one call's arguments against the tool's published input schema. */
export function checkToolArgs(schema: object, args: Args): ToolArgsCheck {
  const next = structuredClone(args)
  const found: Coercion = { coerced: [], refused: new Set() }
  const top: Args = { ...schema }
  if (isRecord(top.properties)) coerceObject(top.properties, next, '', found)
  const own: Args = {}
  for (const [key, value] of Object.entries(next)) if (!ENVELOPE_KEYS.has(key)) own[key] = value
  const result = validatorFor(schema).validate(own)
  if (result.valid) return { ok: true, args: next, coerced: found.coerced }
  const leaf = result.errors.reduce(deeper)
  const field = fieldPath(leaf.instanceLocation)
  const hint = found.refused.has(field)
    ? '; send it as a decimal string (numbers with a fraction or above 2^53 are not converted)'
    : ''
  const message = `${field === '' ? 'arguments' : field}: ${leaf.error.replace(/^Instance\s*/i, '')}${hint}`
  return { ok: false, error: new ToolArgsError(message, field), args: next }
}

/**
 * Checks a call and applies the mode: the coerced arguments when it may run, or the refusal to return. Findings are
 * logged with the tool and field only, never argument values.
 */
export function admitToolArgs(
  tool: string,
  schema: object | undefined,
  args: Args,
  mode: ToolArgsMode,
  log: (line: Args) => void = (line) => console.warn(JSON.stringify(line)),
): { readonly ok: true; readonly args: Args } | { readonly ok: false; readonly error: ToolArgsError } {
  if (schema === undefined) return { ok: true, args }
  const checked = checkToolArgs(schema, args)
  if (checked.ok) {
    if (checked.coerced.length > 0) log({ event: 'tool-args-coerced', tool, fields: checked.coerced })
    return { ok: true, args: checked.args }
  }
  log({ event: 'tool-args-invalid', tool, mode, field: checked.error.field })
  // Log mode still applies the safe coercion; only the refusal waits for enforce.
  return mode === 'enforce' ? checked : { ok: true, args: checked.args }
}
