import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ConfirmButton } from './Sheet.tsx'

test('a destructive button only opens its question: nothing runs and the sheet starts closed', () => {
  let ran = false
  const html = renderToStaticMarkup(
    <ConfirmButton
      title="Disconnect Goblin?"
      description="It stops acting as Quill at once."
      confirm="Disconnect"
      onConfirm={() => {
        ran = true
      }}
    >
      Disconnect
    </ConfirmButton>,
  )
  expect(html).toContain('aria-haspopup="dialog"')
  expect(html).toMatch(/<dialog(?![^>]*\sopen)/)
  expect(ran).toBe(false)
})
