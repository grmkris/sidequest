import { expect, it } from 'vitest'
import { firstPageOnly } from './commons-query.ts'

it('polls an infinite list only while one page is loaded', () => {
  const poll = firstPageOnly(60_000)
  expect(poll({ state: {} })).toBe(60_000)
  expect(poll({ state: { data: { pages: [{}] } } })).toBe(60_000)
  expect(poll({ state: { data: { pages: [{}, {}] } } })).toBe(false)
})
