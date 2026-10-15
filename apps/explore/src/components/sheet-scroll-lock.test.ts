import { describe, expect, it } from 'vitest'
import { lockPageScroll } from './sheet-scroll-lock.ts'

describe('sheet page scroll lock', () => {
  it('locks the page and restores its existing overflow', () => {
    const root = { style: { overflow: 'clip' } }
    const release = lockPageScroll(root)
    expect(root.style.overflow).toBe('hidden')
    release()
    expect(root.style.overflow).toBe('clip')
  })

  it('keeps the page locked while a second sheet opens before the first exits', () => {
    const root = { style: { overflow: '' } }
    const first = lockPageScroll(root)
    const second = lockPageScroll(root)
    first()
    expect(root.style.overflow).toBe('hidden')
    second()
    expect(root.style.overflow).toBe('')
  })

  it('restores only after the last sheet closes, in either order', () => {
    const root = { style: { overflow: 'auto' } }
    const first = lockPageScroll(root)
    const second = lockPageScroll(root)
    second()
    expect(root.style.overflow).toBe('hidden')
    first()
    expect(root.style.overflow).toBe('auto')
  })

  it('ignores a repeated release without unlocking a different sheet', () => {
    const root = { style: { overflow: '' } }
    const first = lockPageScroll(root)
    const second = lockPageScroll(root)
    first()
    first()
    expect(root.style.overflow).toBe('hidden')
    second()
    expect(root.style.overflow).toBe('')
  })

  it('captures the current overflow for each new sequence', () => {
    const root = { style: { overflow: '' } }
    lockPageScroll(root)()
    root.style.overflow = 'scroll'
    const release = lockPageScroll(root)
    release()
    expect(root.style.overflow).toBe('scroll')
  })
})
