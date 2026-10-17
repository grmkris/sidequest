/** Remove only the draft snapshot acknowledged by the host, preserving newer choices. */
export function acknowledgeDraft(current: string, submitted: string): string {
  if (current === submitted) return ''
  if (submitted !== '' && current.startsWith(`${submitted}\n\n`)) return current.slice(submitted.length + 2)
  return current
}
