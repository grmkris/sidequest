import { useEffect, useState } from 'react'

/** Keeps fast-changing input out of a query until typing pauses. */
export function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
