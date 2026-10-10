import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the self-run guide', () => {
  it('shows the example script exactly as it is checked in (and typechecked) in the sdk', () => {
    const guide = read('../content/docs/guides/self-run.mdx')
    const block = /```ts title="self-run-hire\.ts"\n([\s\S]*?)```/.exec(guide)?.[1]
    expect(block).toBe(read('../../../packages/sdk/scripts/examples/self-run-hire.ts'))
  })
})
