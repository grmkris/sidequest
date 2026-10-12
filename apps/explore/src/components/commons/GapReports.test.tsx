import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import type { GapDetail, GapReport } from '../../commons.ts'
import response from './fixtures/gap6.json'
import { GapReports } from './GapReports.tsx'

const textOf = (node: DefaultTreeAdapterTypes.Node): string =>
  // SAFETY: parse5's #text discriminator identifies its TextNode variant.
  node.nodeName === '#text'
    ? (node as DefaultTreeAdapterTypes.TextNode).value
    : 'childNodes' in node
      ? node.childNodes.map(textOf).join('')
      : ''
// SAFETY: this fixture is the unmodified successful public list_gaps response captured from dev on 12 October.
const detail = response.result as GapDetail

it('shows all three original public reports from the dev API, including suggestions and merge provenance', () => {
  const html = renderToStaticMarkup(<GapReports reports={detail.reports} />)
  const text = textOf(parseFragment(html))
  for (const report of detail.reports) {
    expect(text).toContain(`Report #${report.id}`)
    expect(text).toContain(report.whatINeeded)
    expect(text).toContain(report.whatITried)
    expect(text).toContain(report.suggestion)
  }
  expect(text).toContain('Originally gap #7')
  expect(text).toContain('Originally gap #10')
  expect(text).not.toContain('Private goal')
})

it('renders hidden placeholders and only renders a user goal when the backend included it', () => {
  const report: GapReport = {
    ...detail.reports[0]!,
    whatINeeded: 'First line\nSecond line',
    userGoal: 'role-only goal',
  }
  const visible = renderToStaticMarkup(<GapReports reports={[report]} />)
  expect(visible).toContain('First line\nSecond line')
  expect(visible).toContain('role-only goal')
  const hidden = renderToStaticMarkup(
    <GapReports
      reports={[
        {
          ...report,
          whatINeeded: null,
          whatITried: null,
          suggestion: null,
          userGoal: null,
          hidden: { role: 'moderator', reason: 'Spam report', at: 1791653413, logSeq: 3 },
        },
      ]}
    />,
  )
  expect(hidden).toContain('Report text is hidden.')
  expect(hidden).toContain('Hidden by Moderator: Spam report')
  expect(hidden).not.toContain('role-only goal')
  expect(hidden).not.toContain(report.whatITried)
})
