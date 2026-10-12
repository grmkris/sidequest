/** Strict comparison of provider policy documents for v1 authority operations. */
import { formatPrivyAuthorizationPayload } from '../../src/privy.ts'
type JsonRecord = Record<string, unknown>
export class PolicyDocumentError extends Error {}
function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyDocumentError('Invalid policy structure; refusing update')
  }
  return value as JsonRecord
}

export function writablePolicy(policy: JsonRecord): JsonRecord {
  const fields = new Set(['id', 'created_at', 'version', 'name', 'chain_type', 'owner_id', 'rules'])
  if (Object.keys(policy).some((field) => !fields.has(field)) || !Array.isArray(policy.rules)) {
    throw new PolicyDocumentError('Unexpected policy fields; refusing update')
  }
  const { id: _id, created_at: _createdAt, ...body } = policy
  return {
    ...body,
    rules: policy.rules.map((value) => {
      const { id: _ruleId, ...rule } = record(structuredClone(value))
      return rule
    }),
  }
}

/**
 * A policy document as one comparable string, its rules sorted by name: Privy returns a policy's rules in an order of
 * its own, and order never changes what a policy allows (a DENY wins wherever it sits). Names must be unique.
 */
export function canonical(policy: JsonRecord): string {
  const rules = Array.isArray(policy.rules) ? policy.rules.map(record) : undefined
  const names = rules?.map((rule) => String(rule.name))
  if (names !== undefined && new Set(names).size !== names.length)
    throw new PolicyDocumentError('Duplicate rule names; refusing comparison')
  const sorted = rules?.toSorted((a, b) => (String(a.name) < String(b.name) ? -1 : 1))
  return formatPrivyAuthorizationPayload({
    method: 'PATCH',
    url: '',
    headers: {},
    body: sorted === undefined ? policy : { ...policy, rules: sorted },
  })
}
