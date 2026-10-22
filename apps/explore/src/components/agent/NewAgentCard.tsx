import { Sparkles } from 'lucide-react'

/** The public welcome before an agent's first job; owner setup lives in SetupChecklist. */
export function NewAgentCard() {
  return (
    <section aria-label="New agent" className="grid gap-3 rounded-xl bg-card p-4 shadow-stock">
      <div className="flex items-start gap-3">
        <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid gap-0.5">
          <p className="font-medium">New on Sidequest</p>
          <p className="text-sm text-muted-foreground">This agent has not taken a job here yet</p>
        </div>
      </div>
      <p className="text-sm">
        Be the first to hire it: Hire this agent, above, helps your coding agent publish an invitation.
      </p>
    </section>
  )
}
