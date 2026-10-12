import { expect, it } from 'vitest'
import { getTypesForEIP712Domain, hashTypedData } from 'viem'
import { prompts, stepsPrompt, walletTypedData } from './wallet-prompt.ts'
import { typedDataArgs } from './typed-data.ts'

it('every wallet prompt names what it allows, briefly, with a short button', () => {
  const all = [
    prompts.registration('Quill'),
    prompts.weeklyBudget('Quill', '25 mUSD'),
    prompts.hire('Quill', '9 mUSD'),
    prompts.permission('Quill', 'Up to 5 mUSD in total from your wallet, only to 0x12…34.'),
    prompts.jobBudget('10 mUSD'),
    prompts.sponsorship(),
    prompts.selection('Agent ID 7'),
    prompts.backingPermit('Quill', '1,000'),
  ]
  for (const prompt of all) {
    expect(prompt.title.length).toBeLessThanOrEqual(40)
    expect(prompt.description.length).toBeLessThanOrEqual(200)
    expect(prompt.buttonText.split(' ').length).toBeLessThanOrEqual(2)
    expect(`${prompt.title} ${prompt.description}`).not.toMatch(/delegat|caveat|0xfff/i)
  }
  expect(prompts.hire('Quill', '9 mUSD').description).toContain('exactly 9 mUSD')
  expect(prompts.backingPermit('Quill', '1,000').title).toBe('Back Quill')
})

it('a transaction says what its steps do, and why a call to itself goes to your own address', () => {
  expect(stepsPrompt([{ description: 'Back with 1,000 SIDE to Quill' }], true)).toEqual({
    description: 'Back with 1,000 SIDE to Quill. Your wallet sends this to itself and runs it in one go.',
    buttonText: 'Send',
  })
  expect(
    stepsPrompt([{ description: 'Approve SIDE for the vault.' }, { description: 'Back this wallet' }], false),
  ).toEqual({
    description: '2 steps in one transaction: Approve SIDE for the vault; Back this wallet.',
    buttonText: 'Send',
  })
})

// 12 Oct on dev: without the EIP712Domain type Privy signed an empty domain and the registration grant was refused.
it('sends the wallet the typed data wagmi would, with the domain type it hashes', () => {
  const board = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Grant: [
        { name: 'delegate', type: 'address' },
        { name: 'salt', type: 'uint256' },
      ],
    },
    primaryType: 'Grant',
    domain: { name: 'DelegationManager', version: '1', chainId: 10143, verifyingContract: `0x${'11'.repeat(20)}` },
    message: {
      delegate: `0x${'22'.repeat(20)}`,
      salt: '60247279481910972239656324876737415394005608883608232257022683240022167938067',
    },
  })
  const args = typedDataArgs(board)
  const sent = JSON.parse(walletTypedData(args))
  expect(sent.types.EIP712Domain).toEqual(getTypesForEIP712Domain({ domain: sent.domain }))
  expect(sent.message.salt).toBe('60247279481910972239656324876737415394005608883608232257022683240022167938067')
  expect(hashTypedData({ ...sent, message: { ...sent.message, salt: BigInt(sent.message.salt) } })).toBe(
    hashTypedData(args),
  )
})
