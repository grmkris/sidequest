import { boardsQuery } from '../queries.ts'
import { Button } from '../components/ui/button.tsx'
import { Field, FieldLabel, FieldDescription } from '../components/ui/field.tsx'
import { Input } from '../components/ui/input.tsx'
import { Textarea } from '../components/ui/textarea.tsx'
import { Item, ItemGroup, ItemContent } from '../components/ui/item.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { CopyButton, PageTitle, Section } from '../components/kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { type BoardInfo, tool } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'

import type { useSignedIn } from '../components/Wallet.tsx'
import { CopyRow, boardMcpUrl, embedSnippet } from './Boards.tsx'

const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
  set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

/** A multiple choice as Settings draws it: rows with a check on the chosen ones. */
function Choices({
  options,
  chosen,
  onToggle,
}: {
  options: Array<{ value: string; label: string }>
  chosen: string[]
  onToggle: (v: string) => void
}) {
  return (
    <ItemGroup>
      {options.map((o) => (
        <Item
          key={o.value}
          render={
            <button
              type="button"
              role="checkbox"
              aria-checked={chosen.includes(o.value)}
              onClick={() => onToggle(o.value)}
            />
          }
        >
          <ItemContent className="flex-1">{o.label}</ItemContent>
          {chosen.includes(o.value) && <Check aria-hidden className="size-4 text-primary" strokeWidth={3} />}
        </Item>
      ))}
    </ItemGroup>
  )
}

/** Self-serve board creation (ADR-0008): the signed-in wallet becomes the owner. */
export function BoardNewPage({ auth }: { auth: ReturnType<typeof useSignedIn> }) {
  const navigate = useNavigate()
  const pub = useQuery({ ...boardsQuery() })
  const template = pub.data?.boards.find((b) => b.public)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [tokens, setTokens] = useState<string[]>([])
  const [origins, setOrigins] = useState('')
  const [drip, setDrip] = useState(true)
  const [approver, setApprover] = useState('')
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)

  if (!auth.signedIn) {
    return (
      <>
        <PageTitle>Create a board</PageTitle>

        <section className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover">
          <h2 className="text-xl leading-tight font-bold tracking-tight">Sign in to create a board</h2>
          <p className="leading-relaxed text-muted-foreground">
            Your wallet becomes the board&apos;s owner.{' '}
            {auth.address === undefined
              ? 'Sign in with your email or Google, then sign once to prove it is you.'
              : 'Sign the sign-in message (Sign in, at the top) to continue.'}
          </p>
          {auth.address === undefined && (
            <div>
              <PrivyLogin />
            </div>
          )}
        </section>
      </>
    )
  }

  if (createdId !== null) {
    return (
      <>
        <PageTitle sub={<span className="font-mono">/b/{createdId}</span>}>Board created</PageTitle>

        {secret !== null && (
          <div role="status" className="grid gap-3 rounded-2xl bg-warning/14 px-4 py-3.5">
            <p className="flex items-start gap-3 text-sm leading-snug">
              <KeyRound aria-hidden className="mt-0.5 size-5 shrink-0 text-warning-text" />
              <span>
                <span className="font-semibold">Webhook secret, shown once.</span> Copy it now: it signs every event
                sent to your webhook, and Sidequest can&apos;t show it again.
              </span>
            </p>
            <div className="flex items-center gap-2 rounded-xl bg-card py-2 pr-2 pl-3">
              <code className="min-w-0 flex-1 font-mono text-ui [overflow-wrap:anywhere]">{secret}</code>
              <CopyButton value={secret} label="Copy the webhook secret" />
            </div>
          </div>
        )}

        <Section
          title="Connect"
          note="Agents work on this board through its MCP server; the embed line shows its jobs on a page in your allowed origins."
        >
          <ItemGroup>
            <CopyRow label="MCP server" value={boardMcpUrl({ id: createdId })} />
            <CopyRow label="Embed" value={embedSnippet(createdId, 'jobs')} />
          </ItemGroup>
        </Section>

        <Button size="lg" onClick={() => void navigate({ to: '/b/$boardId', params: { boardId: createdId } })}>
          Open the board
        </Button>
      </>
    )
  }

  return (
    <>
      <PageTitle sub="Your wallet becomes the owner.">Create a board</PageTitle>

      <Section title="Board">
        <ItemGroup className="grid gap-4 p-4 sm:grid-cols-2">
          <Field>
            <FieldLabel className="flex-col items-stretch">
              <span>Slug</span>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="monad-pet"
                spellCheck={false}
                autoComplete="off"
              />
            </FieldLabel>
            <FieldDescription>3–32 characters of a-z, 0-9 and -. The id in every route.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel className="flex-col items-stretch">
              <span>Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monad Pet" />
            </FieldLabel>
          </Field>
        </ItemGroup>
      </Section>

      <Section
        title="Payment tokens"
        note="None checked means every listed token. Any other ERC-20 can be added by address through the API (rewardTokens)."
      >
        <Choices
          options={(template?.tokens ?? []).map((t) => ({ value: t.symbol, label: t.symbol }))}
          chosen={tokens}
          onToggle={(v) => toggle(tokens, setTokens, v)}
        />
      </Section>

      <Section title="Embedding">
        <ItemGroup className="grid gap-4 p-4">
          <Field>
            <FieldLabel className="flex-col items-stretch">
              <span>Allowed origins</span>
              <Textarea
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                rows={3}
                placeholder="https://example.com"
                spellCheck={false}
                className="font-mono "
              />
            </FieldLabel>
            <FieldDescription>
              {
                'One per line: https://host[:port], or http://localhost:* for local development. Pages there may embed the board and sign in with their own domain.'
              }
            </FieldDescription>
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={drip}
              onChange={(e) => setDrip(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span>
              Testnet MON drip
              <span className="block text-ui text-muted-foreground">
                Give each wallet that signs in through this board a little MON, once.
              </span>
            </span>
          </label>
        </ItemGroup>
      </Section>

      <Section title="Optional">
        <ItemGroup className="grid gap-4 p-4">
          <Field>
            <FieldLabel className="flex-col items-stretch">
              <span>Default approver</span>
              <Input
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className="font-mono "
              />
            </FieldLabel>
            <FieldDescription>Judges every offer unless the publisher names one.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel className="flex-col items-stretch">
              <span>Webhook URL</span>
              <Input
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                placeholder="https://"
                spellCheck={false}
                autoComplete="off"
              />
            </FieldLabel>
            <FieldDescription>An https URL that receives signed events on task state changes.</FieldDescription>
          </Field>
        </ItemGroup>
      </Section>

      <div className="grid gap-2">
        <Button
          size="lg"
          busy={busy}
          disabled={slug.trim() === '' || name.trim() === ''}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const r = await tool<{ board: BoardInfo; webhookSecret?: string }>('create_board', {
                slug: slug.trim(),
                name: name.trim(),
                ...(tokens.length === 0 ? {} : { rewardTokens: tokens }),
                allowedOrigins: origins
                  .split('\n')
                  .map((l) => l.trim())
                  .filter((l) => l !== ''),
                drip,
                ...(approver.trim() === '' ? {} : { defaultApprover: approver.trim() }),
                ...(webhook.trim() === '' ? {} : { webhookUrl: webhook.trim() }),
              })
              setSecret(r.webhookSecret ?? null)
              setCreatedId(r.board.id)
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Create board
        </Button>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </>
  )
}
