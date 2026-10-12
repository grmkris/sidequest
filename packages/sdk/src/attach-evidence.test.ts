import { decodeFunctionData } from 'viem'
import { expect, it } from 'vitest'
import { hashText } from './actions.ts'
import { context } from './client.ts'
import { sidequestEvaluatorAbi } from './abi/index.ts'
import { attachEvidenceCall, type SignedEvidenceAttestation } from './batch.ts'

it('builds the exact zero-value signed evidence call without RPC', () => {
  const ctx = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const signed: SignedEvidenceAttestation = {
    attestation: {
      jobId: '42',
      submissionHash: hashText('delivery'),
      policyHash: hashText('policy'),
      repo: hashText('repository'),
      headSha: hashText('head'),
      testedSha: hashText('tested'),
      checkRunsHash: hashText('checks'),
      conclusion: 1,
      validUntil: '2000000000',
    },
    verifier: ctx.deployment.attester,
    signature: '0x1234',
  }
  const before = JSON.stringify(signed),
    call = attachEvidenceCall(ctx, signed)
  expect(call).toMatchObject({ to: ctx.stack.evaluator, value: 0n })
  const decoded = decodeFunctionData({ abi: sidequestEvaluatorAbi, data: call.data })
  expect(decoded.functionName).toBe('attachEvidence')
  expect(decoded.args).toEqual([
    42n,
    { ...signed.attestation, jobId: 42n, validUntil: 2000000000n },
    signed.verifier,
    signed.signature,
  ])
  expect(JSON.stringify(signed)).toBe(before)
  expect(
    attachEvidenceCall(ctx, {
      ...signed,
      attestation: { ...signed.attestation, jobId: 42n, validUntil: 2000000000n },
    }),
  ).toEqual(call)
})
