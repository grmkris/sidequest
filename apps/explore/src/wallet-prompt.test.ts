import { expect, it } from 'vitest'
import { prompts } from './wallet-prompt.ts'

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
