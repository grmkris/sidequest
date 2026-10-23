/** GitHub/custom adapters for the OIDC UI policy contract. */
import { githubOidcPolicy, OidcPolicySchema, validateOidcPolicy } from '@sidequest/sdk/oidc-policy'

export interface WorkloadFields {
  provider: 'github' | 'custom'
  label: string
  audience: string
  repository: string
  branch: string
  workflow: string
  issuer: string
  subject: string
  extraClaims: string
  work: boolean
  hire: boolean
}

export const workloadDefaults: WorkloadFields = {
  provider: 'github',
  label: '',
  audience: '',
  repository: '',
  branch: 'main',
  workflow: '',
  issuer: '',
  subject: '',
  extraClaims: '{}',
  work: false,
  hire: false,
}

/** Same payload for a browser save and the owner API; no token is ever pasted into this form. */
export function compileWorkloadPolicy(fields: WorkloadFields, resource: string) {
  const policy =
    fields.provider === 'github'
      ? githubOidcPolicy(fields.repository.trim(), fields.branch.trim(), fields.audience.trim(), fields.label.trim())
      : OidcPolicySchema.parse({
          issuer: fields.issuer.trim(),
          label: fields.label.trim(),
          claims: {
            ...OidcPolicySchema.shape.claims.parse(JSON.parse(fields.extraClaims)),
            aud: [fields.audience.trim()],
            sub: [fields.subject.trim()],
          },
        })
  if (fields.provider === 'github') {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(fields.repository.trim()) || fields.branch.trim() === '')
      throw new Error('Provide owner/repo and a branch name')
    if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(fields.workflow.trim()))
      throw new Error('Provide a workflow path such as .github/workflows/agent.yml')
    policy.claims.workflow_ref = [
      `${fields.repository.trim()}/${fields.workflow.trim()}@refs/heads/${fields.branch.trim()}`,
    ]
  }
  const errors = validateOidcPolicy(policy)
  if (errors.length > 0) throw new Error(errors.map((error) => `${error.path}: ${error.message}`).join('; '))
  return {
    policy,
    resource,
    scopes: ['sidequest:read', ...(fields.work ? ['sidequest:work'] : []), ...(fields.hire ? ['sidequest:hire'] : [])],
  }
}
