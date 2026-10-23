/** Adapted from https://ui.shadcn.com/oidc/r/policy.json (retrieved 2026-10-23). */
import { z } from 'zod'

export const OidcPolicySchema = z
  .object({
    issuer: z.string().max(2048),
    claims: z.record(z.string(), z.array(z.string().min(1).max(2048)).min(1).max(20)),
    label: z.string().max(120).optional(),
  })
  .strict()

export type OidcPolicy = z.infer<typeof OidcPolicySchema>

/** Save and verification share this gate; malformed stored policies fail closed. */
export function validateOidcPolicy(value: unknown): { path: string; message: string }[] {
  const parsed = OidcPolicySchema.safeParse(value)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  const { issuer, claims } = parsed.data
  const errors: { path: string; message: string }[] = []
  try {
    const url = new URL(issuer)
    if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '')
      errors.push({ path: 'issuer', message: 'Issuer must use HTTPS without credentials, query or fragment.' })
  } catch {
    errors.push({ path: 'issuer', message: 'Issuer must be a valid HTTPS URL.' })
  }
  if (!Object.hasOwn(claims, 'aud')) errors.push({ path: 'claims.aud', message: 'An audience (aud) rule is required.' })
  for (const name of Object.keys(claims)) {
    if (name.trim() === '' || ['__proto__', 'constructor', 'prototype'].includes(name))
      errors.push({ path: `claims.${name}`, message: 'Claim name is not allowed.' })
  }
  return errors
}

/** Only call with a verified payload. Each rule is exact; arrays match on string intersection. */
export function matchOidcPolicy(policy: OidcPolicy, claims: Record<string, unknown>): boolean {
  if (validateOidcPolicy(policy).length > 0 || claims.iss !== policy.issuer) return false
  return Object.entries(policy.claims).every(([name, accepted]) => {
    const actual = claims[name]
    const values: unknown[] = Array.isArray(actual) ? actual : [actual]
    return values.some((value) => z.string().safeParse(value).success && accepted.includes(String(value)))
  })
}

/** GitHub provider's repository/ref compiler, with an explicit audience and an exact subject. */
export function githubOidcPolicy(repository: string, branch: string, audience: string, label: string): OidcPolicy {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    label,
    claims: {
      aud: [audience],
      sub: [`repo:${repository}:ref:refs/heads/${branch}`],
      repository: [repository],
      ref: [`refs/heads/${branch}`],
    },
  }
}
