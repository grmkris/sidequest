import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { compileWorkloadPolicy, workloadDefaults } from '../../workload-policy.ts'
import { WorkloadPolicyForm } from './WorkloadPolicyForm.tsx'

const resource = 'https://sidequest.example/mcp'
const github = {
  ...workloadDefaults,
  label: 'Build agent',
  audience: 'https://sidequest.example/oauth/token',
  repository: 'acme/agent',
  branch: 'main',
  workflow: '.github/workflows/agent.yml',
  work: true,
}

it('renders the GitHub policy form with labels, an explicit scope cap and a safe default audience', () => {
  const html = renderToStaticMarkup(<WorkloadPolicyForm resource={resource} onSave={async () => {}} />)
  for (const label of [
    'Trust a workload',
    'GitHub Actions',
    'Custom issuer',
    'Policy name',
    'Repository',
    'Branch',
    'Workflow path',
    'Maximum access',
    'Get hired',
    'Save trust policy',
    'https://sidequest.example/oauth/token',
  ])
    expect(html).toContain(label)
  expect(html).not.toContain('type="password"')
  expect(html).toContain('type="submit"')
})

it('compiles a GitHub workflow on main into exact rules and only the explicitly ticked scopes', () => {
  const payload = compileWorkloadPolicy(github, resource)
  expect(payload).toEqual({
    resource,
    scopes: ['sidequest:read', 'sidequest:work'],
    policy: {
      issuer: 'https://token.actions.githubusercontent.com',
      label: 'Build agent',
      claims: {
        aud: ['https://sidequest.example/oauth/token'],
        repository: ['acme/agent'],
        ref: ['refs/heads/main'],
        sub: ['repo:acme/agent:ref:refs/heads/main'],
        workflow_ref: ['acme/agent/.github/workflows/agent.yml@refs/heads/main'],
      },
    },
  })
})

it('validates custom issuer, subject and extra rules with the same OIDC UI save validator', () => {
  const fields = {
    ...github,
    provider: 'custom' as const,
    issuer: 'https://swarmm.example',
    subject: 'worker:42',
    extraClaims: '{"team":["core"]}',
    hire: true,
  }
  const payload = compileWorkloadPolicy(fields, resource)
  expect(payload.policy.claims).toMatchObject({ team: ['core'], sub: ['worker:42'] })
  const html = renderToStaticMarkup(<WorkloadPolicyForm initial={fields} resource={resource} onSave={async () => {}} />)
  expect(html).toContain('HTTPS issuer')
  expect(html).toContain('Additional claim rules (JSON)')
  expect(() => compileWorkloadPolicy({ ...fields, issuer: 'http://swarmm.example' }, resource)).toThrow('HTTPS')
  expect(() => compileWorkloadPolicy({ ...fields, subject: '' }, resource)).toThrow()
  expect(() => compileWorkloadPolicy({ ...fields, extraClaims: '{"team":[]}' }, resource)).toThrow()
})

it('refuses unpinned repositories/workflows and missing audience before a save', () => {
  for (const patch of [{ repository: '*' }, { branch: '' }, { workflow: '*' }, { audience: '' }])
    expect(() => compileWorkloadPolicy({ ...github, ...patch }, resource)).toThrow()
})
