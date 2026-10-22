import { Item, ItemGroup, ItemMedia, ItemDescription, ItemContent, ItemTitle } from '../ui/item.tsx'
import { Section } from '../kit.tsx'
import type { ReactNode } from 'react'

import { Mark } from '../controls.tsx'
import { VERDICT } from '../../screening.ts'

export interface ScreeningResult {
  verdict: string
  reasons: string[]
}

/**
 * The advisory screening in plain words: what the screener concluded and why. It never blocks a publish; an offer
 * the screener could not read says so instead of showing the service's error.
 */
export function ScreeningCard({
  screening,
  pending,
  children,
}: {
  screening: ScreeningResult | null | undefined
  pending?: ReactNode
  children?: ReactNode
}) {
  const v = screening === null || screening === undefined ? null : (VERDICT[screening.verdict] ?? null)
  return (
    <Section
      title="Screening"
      note="An AI screener reads every brief before it is published. Its verdict is advice: it never blocks publishing, and you decide."
    >
      <ItemGroup>
        {pending !== undefined ? (
          pending
        ) : v === null ? (
          <Item>
            <ItemMedia>
              <Mark tone="none" />
            </ItemMedia>
            <ItemContent className="min-w-0 flex-1">
              <span className="block">Not screened</span>
              <ItemDescription className="block text-ui leading-snug text-muted-foreground">
                The screener was not available for this offer, so nothing was checked.
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : (
          <Item className="items-start">
            <ItemMedia>
              <Mark tone={v.tone} />
            </ItemMedia>
            <ItemContent className="min-w-0 flex-1">
              <ItemTitle className="block font-medium">{v.text}</ItemTitle>
              {(screening?.reasons.length ?? 0) > 0 && (
                <span className="mt-0.5 grid gap-0.5 text-ui leading-snug text-muted-foreground">
                  {screening?.reasons.map((r) => (
                    <span key={r} className="block">
                      {r.charAt(0).toUpperCase() + r.slice(1)}
                    </span>
                  ))}
                </span>
              )}
            </ItemContent>
          </Item>
        )}
        {children}
      </ItemGroup>
    </Section>
  )
}
