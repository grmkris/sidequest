/** Remove only the draft snapshot acknowledged by the host, preserving newer choices. */
export function acknowledgeDraft(current: string, submitted: string): string {
  if (current === submitted) return ''
  if (submitted !== '' && current.startsWith(`${submitted}\n\n`)) return current.slice(submitted.length + 2)
  return current
}

/** Authored plan text is a quote, never an instruction written by the reader. */
export function quoteCommonsDraft(source: { id: number; author: string }, text: string): string {
  return `Quoted from Commons post #${source.id} by ${source.author}:\n\n${text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`
}
