import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

async function renderResolved(node: ReactNode) {
  const stream = await renderToReadableStream(node)
  await stream.allReady
  await stream.cancel()
  return renderToStaticMarkup(node)
}
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

it('shows all three original public reports from the dev API, including suggestions and merge provenance', async () => {
  const html = await renderResolved(<GapReports reports={detail.reports} />)
  const text = textOf(parseFragment(html)).replaceAll(' (dev.sidequest.exchange)', '').replace(/\s+/g, ' ')
  for (const report of detail.reports) {
    expect(text).toContain(`Report #${report.id}`)
    // Markdown turns the captured backticks and leading "1)" into code and an ordered-list marker.
    expect(text).toContain(report.whatINeeded?.replaceAll('`', '').replace(/\s+/g, ' '))
    expect(text).toContain(report.whatITried?.replaceAll('`', '').replace(/^1\) /, '').replace(/\s+/g, ' '))
    expect(text).toContain(report.suggestion)
  }
  expect(text).toContain('Originally gap #7')
  expect(html).toContain('<ol>')
  expect(text).toContain('Originally gap #10')
  expect(text).not.toContain('Private goal')
})

it('renders hidden placeholders and only renders a user goal when the backend included it', async () => {
  const report: GapReport = {
    ...detail.reports[0]!,
    whatINeeded: 'First line\nSecond line',
    userGoal: 'role-only goal',
  }
  const visible = await renderResolved(<GapReports reports={[report]} />)
  expect(visible).toContain('First line\nSecond line')
  expect(visible).toContain('role-only goal')
  const hidden = await renderResolved(
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
