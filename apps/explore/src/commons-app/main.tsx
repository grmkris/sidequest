import { App, type AppEventMap } from '@modelcontextprotocol/ext-apps'
import { CommonsPresentation } from '@sidequest/react/commons-ui'
import { createRoot } from 'react-dom/client'
import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useState } from 'react'
import { acknowledgeDraft, quoteCommonsDraft } from './draft.ts'
import { parseCommonsAppResult, type CommonsAppView } from './result.ts'

const app = new App({ name: 'Sidequest Commons', version: '1.0.0' }, {}, { strict: true })

function useCommonsHost() {
  const [view, setView] = useState<CommonsAppView>()
  const [status, setStatus] = useState('Connecting to the conversation…')
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const toolResult = (reply: AppEventMap['toolresult']) => {
      try {
        if (reply.isError) throw new Error('Read failed')
        const text = reply.content?.find((part) => part.type === 'text')
        const payload = reply.structuredContent ?? (text?.type === 'text' ? JSON.parse(text.text) : undefined)
        setView(parseCommonsAppResult(payload))
        setStatus('')
      } catch {
        setView(undefined)
        setStatus('This thread result could not be displayed. Read the text response in your conversation.')
      }
    }
    const contextChanged = (context: AppEventMap['hostcontextchanged']) => {
      if (context.theme !== undefined) document.documentElement.dataset.theme = context.theme
    }
    app.addEventListener('toolresult', toolResult)
    app.addEventListener('hostcontextchanged', contextChanged)
    void app
      .connect()
      .then(() => {
        document.documentElement.dataset.theme = app.getHostContext()?.theme ?? 'light'
        setConnected(true)
      })
      .catch(() => setStatus('The host connection is unavailable. Read the text response in your conversation.'))
    return () => {
      app.removeEventListener('toolresult', toolResult)
      app.removeEventListener('hostcontextchanged', contextChanged)
      void app.close()
    }
  }, [])
  return { view, status, setStatus, connected }
}

function CommonsApp() {
  const { view, status, setStatus, connected } = useCommonsHost()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const sendDraft = async () => {
    if (sending || draft.trim() === '') return
    setSending(true)
    try {
      const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: draft }] })
      if (result.isError) throw new Error('Host declined')
      // Attachments may append another choice while the host acknowledges this snapshot.
      setDraft((current) => acknowledgeDraft(current, draft))
      setStatus('Sent to the conversation. No Commons message has been posted by this view.')
    } catch {
      setStatus('The conversation did not confirm receipt. Your draft is still here; check before sending again.')
    } finally {
      setSending(false)
    }
  }
  return <AppContent {...{ view, status, setStatus, connected, draft, setDraft, sending, sendDraft }} />
}

function AppContent({
  view,
  status,
  setStatus,
  connected,
  draft,
  setDraft,
  sending,
  sendDraft,
}: {
  view: CommonsAppView | undefined
  status: string
  setStatus: (status: string) => void
  connected: boolean
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  sending: boolean
  sendDraft: () => Promise<void>
}) {
  return (
    <main>
      <h1>Commons</h1>
      <output>{status}</output>
      {view !== undefined && (
        <>
          <p className="muted">{view.subject}</p>
          {view.messages.length === 0 && <p>No messages in this page.</p>}
          {view.messages.map((message) => (
            <MessageArticle key={message.id} message={message} setDraft={setDraft} setStatus={setStatus} />
          ))}
          {view.hasMore && <p>More thread history is available. Ask your agent for another page.</p>}
        </>
      )}
      {draft !== '' && <DraftPanel {...{ draft, setDraft, connected, sending, sendDraft }} />}
    </main>
  )
}

function MessageArticle({
  message,
  setDraft,
  setStatus,
}: {
  message: CommonsAppView['messages'][number]
  setDraft: Dispatch<SetStateAction<string>>
  setStatus: (status: string) => void
}) {
  return (
    <article>
      <header>
        Post {message.id} · {message.author}
      </header>
      {message.hidden !== null || message.body === null ? (
        <p>Hidden by moderation.</p>
      ) : (
        <>
          <p className="body">{message.body}</p>
          {message.presentation !== undefined && message.presentation !== null && (
            <CommonsPresentation
              value={message.presentation}
              onOpenLink={(url) => {
                void app
                  .openLink({ url })
                  .catch(() => setStatus('The host could not open this link. Its URL is shown beside the source.'))
              }}
              onDraft={(text) =>
                setDraft((current) => [current, quoteCommonsDraft(message, text)].filter(Boolean).join('\n\n'))
              }
            />
          )}
        </>
      )}
    </article>
  )
}

function DraftPanel({
  draft,
  setDraft,
  connected,
  sending,
  sendDraft,
}: {
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  connected: boolean
  sending: boolean
  sendDraft: () => Promise<void>
}) {
  return (
    <section className="draft">
      <label htmlFor="reply-draft">Review your conversation draft</label>
      <textarea id="reply-draft" value={draft} disabled={sending} onChange={(event) => setDraft(event.target.value)} />
      <p className="muted">
        This sends the text below to your conversation. Posting to Commons remains a separate action.
      </p>
      <button
        type="button"
        disabled={!connected || sending}
        onClick={() => {
          void sendDraft()
        }}
      >
        Send draft to conversation
      </button>
      <button type="button" disabled={sending} onClick={() => setDraft('')}>
        Discard draft
      </button>
    </section>
  )
}

const root = document.getElementById('root')
if (root !== null) createRoot(root).render(<CommonsApp />)
