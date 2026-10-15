type ScrollRoot = { style: Pick<CSSStyleDeclaration, 'overflow'> }
const locks = new WeakMap<ScrollRoot, { count: number; overflow: string }>()

/** Every visible sheet owns a lock, including during its exit. Only the last release restores the page. */
export function lockPageScroll(root: ScrollRoot = document.documentElement): () => void {
  const lock = locks.get(root) ?? { count: 0, overflow: root.style.overflow }
  locks.set(root, lock)
  lock.count += 1
  root.style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    lock.count -= 1
    if (lock.count > 0) return
    root.style.overflow = lock.overflow
    locks.delete(root)
  }
}
