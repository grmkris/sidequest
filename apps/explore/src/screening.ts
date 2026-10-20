export const verdictText = (verdict: string | undefined) =>
  verdict === undefined ? 'Not screened' : (VERDICT[verdict]?.text ?? 'Not screened')

export const VERDICT: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }> = {
  clean: { text: 'Looks fine', tone: 'ok' },
  caution: { text: 'Flagged for a closer look', tone: 'warn' },
  reject: { text: 'Flagged as risky', tone: 'bad' },
}

/**
 * What an approval should say about the screener's read of a brief before the operator signs: its verdict and reasons
 * when it flagged something, nothing for a clean or unknown verdict. Advice only; signing stays the operator's call.
 */
export function screeningWarning(
  screening: { readonly verdict: string; readonly reasons: readonly string[] } | null | undefined,
): { text: string; tone: 'warn' | 'bad'; reasons: readonly string[] } | null {
  const v = screening == null ? undefined : VERDICT[screening.verdict]
  if (screening == null || v === undefined || (v.tone !== 'warn' && v.tone !== 'bad')) return null
  return { text: v.text, tone: v.tone, reasons: screening.reasons }
}
