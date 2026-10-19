import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { boardPrefix } from '../api.ts'
import { CreateWithAgent } from './CreateWithAgent.tsx'
import { CopyButton } from './kit.tsx'

const PostingContext = createContext({ open: false, setOpen: (_open: boolean) => {} })

/** Welcome must not navigate away from an active Jobs handoff, including when browser storage is blocked. */
export function JobPostingProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <PostingContext value={{ open, setOpen }}>{children}</PostingContext>
}

export const useJobPosting = () => useContext(PostingContext)

function readDraft(key: string) {
  try {
    const brief = sessionStorage.getItem(key) ?? ''
    return { brief, readable: true, saved: brief !== '' }
  } catch {
    return { brief: '', readable: false, saved: false }
  }
}

/** Jobs owns its tab-scoped draft; other publisher handoffs need no storage or draft modes. */
export function PostJob() {
  const key = `sidequest:quote-brief:${boardPrefix()}`
  const [draft, setDraft] = useState(() => readDraft(key))
  const { setOpen } = useJobPosting()
  useEffect(() => () => setOpen(false), [setOpen])
  function updateBrief(brief: string) {
    setDraft((current) => {
      let wrote = false
      try {
        sessionStorage.setItem(key, brief)
        wrote = true
      } catch {
        // The live draft remains usable; the notice below warns before leaving for setup.
      }
      return { brief, readable: current.readable, saved: current.readable && wrote }
    })
  }
  return (
    <CreateWithAgent
      context="quotes"
      brief={draft.brief}
      onOpenChange={setOpen}
      details={
        <div className="grid gap-2">
          <label className="grid gap-2 font-medium">
            Job brief
            <textarea
              aria-label="Job brief"
              value={draft.brief}
              onChange={(event) => updateBrief(event.target.value)}
              rows={4}
              placeholder="What do you need, and how will you check it?"
              className="w-full resize-y rounded-xl border border-input bg-background p-3 text-sm font-normal"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Your brief stays here for sign-in and retry.
            {draft.saved &&
              draft.readable &&
              ' It is saved in this tab for setup and reload. Return to Post a job after setup.'}
          </p>
          {(!draft.readable || (!draft.saved && draft.brief !== '')) && (
            <div role="alert" className="grid gap-2 text-sm">
              <p>Your brief cannot be saved for navigation or reload. Copy it before setup or leaving this page.</p>
              <CopyButton value={draft.brief} label="Copy brief" />
            </div>
          )}
        </div>
      }
    >
      <Plus aria-hidden />
      Post a job
    </CreateWithAgent>
  )
}
