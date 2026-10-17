import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { Message } from '../../commons.ts'
import { MessageRow } from './MessageRow.tsx'
import fixture from './fixtures/gap6.json'

const message: Message = {
  id: 42,
  subject: 'lobby',
  // SAFETY: this reporter address comes from the captured successful public dev response.
  author: fixture.result.reports[0]!.reporter as Message['author'],
  badges: [],
  body: '**Plan**\n\n- [x] Read\n- [ ] Review',
  replyTo: null,
  mentions: [],
  hidden: null,
  createdAt: 1791653413,
}

it('uses the Markdown renderer for a visible post and preserves its reply action', () => {
  const html = renderToStaticMarkup(<MessageRow message={message} you={false} onReply={() => undefined} />)
  expect(html).toContain('<strong>Plan</strong>')
  expect(html).toContain('aria-label="Completed task"')
  expect(html).toContain('aria-label="Incomplete task"')
  expect(html).toContain('Reply</button>')
})

it('never renders the body or a reply action for a hidden message, even when its body was supplied', () => {
  const html = renderToStaticMarkup(
    <MessageRow
      message={{
        ...message,
        hidden: { role: 'moderator', reason: 'Spam', at: 1791653413, logSeq: 2 },
      }}
      you={false}
      onReply={() => undefined}
    />,
  )
  expect(html).toContain('Hidden by Moderator: Spam')
  expect(html).not.toContain('Plan')
  expect(html).not.toContain('type="checkbox"')
  expect(html).not.toContain('Reply</button>')
})

it('renders a valid attachment after the readable Markdown and keeps it local', () => {
  const html = renderToStaticMarkup(
    <MessageRow
      message={{
        ...message,
        body: 'Readable **summary**',
        presentation: {
          protocol: 'sidequest.commons-ui',
          version: 1,
          spec: {
            root: 'plan',
            elements: {
              plan: { type: 'Plan', props: { title: 'Plan', summary: 'Summary' }, children: ['ask'] },
              ask: { type: 'AskQuestion', props: { question: 'Ready?', options: ['Yes', 'Not yet'] } },
            },
          },
        },
      }}
      you={false}
    />,
  )
  expect(html).toContain('Readable <strong>summary</strong>')
  expect(html).toContain('Explore this plan')
  expect(html).toContain('Ready?')
  expect(html).not.toContain('tools/call')
})
