// @vitest-environment happy-dom
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ThreadView } from './ThreadView.tsx'
import type { Message, Thread, Viewer } from '../../commons.ts'
import fixture from './fixtures/gap6.json'

const state = vi.hoisted(() => ({ signedIn: false, listeners: new Set<() => void>(), read: vi.fn(), post: vi.fn() }))
vi.mock('../Wallet.tsx', () => ({
  useAuth: () => ({
    signedIn: useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener)
        return () => state.listeners.delete(listener)
      },
      () => state.signedIn,
    ),
    address: fixture.result.reports[0]!.reporter,
    signIn: async () => {
      state.signedIn = true
      for (const listener of state.listeners) listener()
    },
  }),
  Monogram: () => <span />,
}))
vi.mock('../../api.ts', () => ({
  currentBoardId: () => 'public',
  tool: (name: string, args: unknown) => (name === 'post_message' ? state.post(args) : state.read(args)),
}))
vi.mock('../../commons-access.ts', () => ({
  anonymousCommonsTool: (_board: string, _name: string, args: unknown) => state.read(args),
}))
vi.mock('../side/SideToken.tsx', () => ({ SideChip: () => <span>Get SIDE</span> }))

const message: Message = {
  id: 1,
  subject: 'lobby',
  author: fixture.result.reports[0]!.reporter as Message['author'],
  body: 'Choose a plan',
  presentation: {
    protocol: 'sidequest.commons-ui',
    version: 1,
    spec: {
      root: 'plan',
      elements: {
        plan: { type: 'Plan', props: { title: 'Release plan', summary: 'Pick one.' }, children: ['choice'] },
        choice: { type: 'AskQuestion', props: { question: 'Ready?', options: ['Ship', 'Revise'] } },
      },
    },
  },
  badges: [],
  replyTo: null,
  mentions: [],
  hidden: null,
  createdAt: 1,
}
const viewer: Viewer = {
  address: message.author,
  canPost: true,
  roles: [],
  needs: null,
  minimum: '0',
  stake: null,
  backing: null,
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let container: HTMLDivElement
let root: Root
let client: QueryClient
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}
async function render(subject = 'lobby') {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ThreadView subject={subject} empty="Empty" />
      </QueryClientProvider>,
    )
  })
  await settle()
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
  })
  await settle()
}
function textarea() {
  const el = container.querySelector('textarea')
  if (!el) throw new Error('Composer missing')
  return el
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state.signedIn = false
  state.read.mockReset().mockImplementation(async ({ subject }: { subject: string }): Promise<Thread> => ({
    subject,
    messages: [message],
    viewer: state.signedIn ? viewer : null,
    hasMore: false,
    cursor: null,
    nextPollSeconds: 10,
  }))
  state.post.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  container.remove()
  vi.unstubAllGlobals()
})

it('keeps the composer pending through sign-in and clears the posted draft and reply exactly once', async () => {
  const post = deferred<unknown>()
  state.post.mockReturnValue(post.promise)
  await render()
  await click('Reply')
  await type('One answer')
  const editor = textarea()
  await click('Sign in and post')
  expect(textarea()).toBe(editor)
  expect(textarea().disabled).toBe(true)
  expect(state.post).toHaveBeenCalledTimes(1)
  await act(async () => post.resolve({ notified: 0 }))
  await settle()
  expect(textarea().value).toBe('')
  expect(container.textContent).not.toContain('Replying to')
  expect(button('Post').disabled).toBe(true)
})
it('acknowledges only the posted snapshot when a choice is added while posting', async () => {
  const post = deferred<unknown>()
  state.post.mockReturnValue(post.promise)
  await render()
  await type('One answer')
  await click('Sign in and post')
  await act(async () => {
    ;(container.querySelector('input[type="radio"]') as HTMLInputElement).click()
  })
  await settle()
  await click('Use selection in reply')
  expect(textarea().value).toContain('One answer\n\nReady?\n\nShip')
  await act(async () => post.resolve({ notified: 0 }))
  await settle()
  expect(textarea().value).toBe('Ready?\n\nShip')

  expect(container.textContent).toContain('Replying to')
})
it('shows a post error after sign-in and retains the draft for retry', async () => {
  const post = deferred<unknown>()
  state.post.mockReturnValue(post.promise)
  await render()
  await type('Keep this answer')
  await click('Sign in and post')
  await act(async () => post.reject(new Error('Posting failed')))
  await settle()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Posting failed')
  expect(textarea().value).toBe('Keep this answer')
  expect(button('Post').disabled).toBe(false)
})
