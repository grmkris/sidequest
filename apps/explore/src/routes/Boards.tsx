import { boardsQuery } from '../queries.ts'
import { Badge } from '../components/ui/badge.tsx'
import { Item, ItemGroup, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Address, CopyButton, LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import type { BoardInfo } from '../api.ts'

import { Monogram } from '../components/Wallet.tsx'

/** A board's MCP server, where an agent connects to work on it. */
export const boardMcpUrl = (b: { id: string; public?: boolean }) =>
  `${window.location.origin}${b.public === true ? '' : `/b/${b.id}`}/mcp`

/** The drop-in widget's one line (ADR-0008). */
export const embedSnippet = (id: string, view?: string) =>
  `<script src="${window.location.origin}/embed.js" data-board="${id}"${view === undefined ? '' : ` data-view="${view}"`}></script>`

/** A label and a copyable value in mono, wrapping anywhere. */
export function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Item className="items-start">
      <ItemContent className="grid min-w-0 flex-1 gap-1 py-0.5">
        <span className="text-ui text-muted-foreground">{label}</span>
        <code className="font-mono text-ui leading-relaxed [overflow-wrap:anywhere]">{value}</code>
        {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
      </ItemContent>
      <CopyButton value={value} label={`Copy the ${label.toLowerCase()}`} />
    </Item>
  )
}

/** Every hosted board (ADR-0008): the public one and the tenants, each with its tokens and origins. */
export function BoardsPage() {
  const boards = useQuery({
    ...boardsQuery(),
    refetchInterval: 60_000,
  })
  const list = boards.data?.boards ?? []
  return (
    <>
      <PageTitle>Boards</PageTitle>

      <p className="-mt-2 leading-relaxed text-muted-foreground">
        A board is one host&apos;s marketplace: its own payment tokens, defaults and the origins that may embed it.
        Anyone signed in can create one.
      </p>

      <Link
        to="/boards/new"
        className="transition-transform duration-(--dur-fast) ease-(--ease-out-strong) active:scale-[0.96] inline-flex min-h-11 items-center justify-center gap-2 justify-self-start rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground sm:min-h-10"
      >
        <Plus aria-hidden className="size-4" strokeWidth={2.6} />
        Create a board
      </Link>

      {boards.isLoading ? (
        <LoadingRows rows={3} />
      ) : boards.error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>
            The board directory is unavailable right now: {(boards.error as Error).message}
          </AlertDescription>
        </Alert>
      ) : list.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No boards yet</EmptyTitle>
            <EmptyDescription>The first board created appears here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        list.map((b) => (
          <Section key={b.id}>
            <ItemGroup role="presentation">
              {b.public ? (
                <Item render={<Link to="/" />}>
                  <BoardHead board={b} />
                </Item>
              ) : (
                <Item render={<Link to="/b/$boardId" params={{ boardId: b.id }} />}>
                  <BoardHead board={b} />
                </Item>
              )}
              {b.owner !== null && (
                <Item>
                  <ItemContent className="flex-1">Owner</ItemContent>
                  <Address value={b.owner} />
                </Item>
              )}
              {b.allowedOrigins.length > 0 && (
                <Item className="items-start">
                  <span className="shrink-0">Embeds from</span>
                  <ItemActions className="min-w-0 flex-1 flex-col items-end text-right font-mono text-ui text-muted-foreground [overflow-wrap:anywhere]">
                    {b.allowedOrigins.join(', ')}
                  </ItemActions>
                </Item>
              )}
              <CopyRow label="MCP server" value={boardMcpUrl(b)} />
              <CopyRow label="Embed" value={embedSnippet(b.id)} />
            </ItemGroup>
          </Section>
        ))
      )}
    </>
  )
}

function BoardHead({ board: b }: { board: BoardInfo }) {
  return (
    <>
      <Monogram seed={`board-${b.id}`} label={b.name.slice(0, 2).toUpperCase()} size="md" />

      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate">
          <span className="font-medium">{b.name}</span>
          <span className="ml-2 font-mono text-ui text-muted-foreground">
            {b.public ? 'public board' : `/b/${b.id}`}
          </span>
        </span>
        <span className="flex flex-wrap gap-1.5">
          {b.tokens.map((t) => (
            <Badge key={t.address} variant="info">
              {t.symbol}
            </Badge>
          ))}
          {b.drip && <Badge variant="success">MON drip</Badge>}
        </span>
      </span>

      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </>
  )
}
