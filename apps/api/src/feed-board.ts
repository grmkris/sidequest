/**
 * Board-side feed events (V1.1 WS4), produced inside the Board DO after a tool succeeded, so website, REST and managed
 * MCP calls all count. The recipient comes from the board's own rows; events carry ids and next steps only, never a
 * note, brief or other worker-written text. The two Telegram notices the Worker used to send after these tools move
 * here with their ids unchanged, so a deploy across the move sends nothing twice. Nothing here ever fails the tool.
 */
import type { Sql } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import type { Network } from '@sidequest/sdk'
import { type FeedEvent, PUBLIC_ADDRESS, reportFeedFailure, writeFeed } from './feed.ts'
import { enqueuePublicRequest, enqueueWalletNotification, telegramPublicChannel, publicOrigin } from './telegram.ts'

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

export interface BoardToolEvent {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly result: unknown
  readonly network: Network
  readonly boardId: string
  readonly now: number
}

/** The feed rows one successful board tool produces, read from the board's own tables. */
export function boardFeedEvents(board: Sql, input: BoardToolEvent): FeedEvent[] {
  const { tool, args, boardId, now } = input
  const result = (input.result ?? {}) as Record<string, unknown>
  const base = `${publicOrigin()}${boardId === 'public' ? '' : `/b/${encodeURIComponent(boardId)}`}`
  const jobUrl = (task: { id: string; job_id: string | null }) =>
    `${base}/job/${encodeURIComponent(task.job_id ?? task.id)}`
  const task = (taskId: string | undefined) =>
    taskId === undefined
      ? undefined
      : board.all<{ id: string; creator: string; job_id: string | null }>(
          'SELECT id, creator, job_id FROM tasks WHERE id = ?',
          taskId,
        )[0]
  const requestLink = (taskId: string) => {
    const request = board.all<{ id: string }>('SELECT id FROM quote_requests WHERE task_id = ?', taskId)[0]
    return request === undefined ? {} : { requestId: request.id }
  }

  if (tool === 'pick_quote') {
    const requestId = text(args.requestId),
      quoteId = text(args.quoteId),
      target = task(text(result.taskId))
    if (requestId === undefined || target === undefined) return []
    // Every other bidder learns it lost (gap 4): list_quotes then shows the winning quote and its price.
    const lost: FeedEvent[] =
      quoteId === undefined
        ? []
        : board
            .all<{ worker: string }>('SELECT worker FROM quotes WHERE request_id = ? AND id <> ?', requestId, quoteId)
            .map(({ worker }) => ({
              id: `board:${boardId}:quote-lost:${requestId}:${worker.toLowerCase()}`,
              address: worker,
              kind: 'quote.lost',
              boardId,
              requestId,
              taskId: target.id,
              jobId: target.job_id,
              role: 'bidder',
              summary: `Another quote was picked on request ${requestId}.`,
              url: `${base}/request/${encodeURIComponent(requestId)}`,
              next: { tool: 'list_quotes', args: { requestId } },
              occurredAt: now,
            }))
    const picked = [target.creator, PUBLIC_ADDRESS].map((address) => ({
      id: `board:${boardId}:picked:${requestId}:${address.toLowerCase()}`,
      address,
      kind: 'request.picked',
      boardId,
      requestId,
      taskId: target.id,
      jobId: target.job_id,
      role: address === PUBLIC_ADDRESS ? 'public' : 'creator',
      summary: `Quote request ${requestId} is linked to task ${target.id}; read the chain to verify escrow.`,
      url: jobUrl(target),
      next: { tool: 'get_task', args: { taskId: target.id } },
      occurredAt: now,
    }))
    return [...picked, ...lost]
  }

  if (tool === 'submit_quote') {
    const requestId = text(args.requestId),
      quoteHash = text(result.quoteHash)
    const [request] =
      requestId === undefined
        ? []
        : board.all<{ creator: string; task_id: string | null }>(
            'SELECT creator, task_id FROM quote_requests WHERE id = ?',
            requestId,
          )
    if (requestId === undefined || request === undefined || quoteHash === undefined) return []
    // Keyed by the quote's hash: a bidder replacing its quote (same quote id) is news, a retry is not.
    return [
      {
        id: `board:${boardId}:quote:${quoteHash}`,
        address: request.creator,
        kind: 'quote.received',
        boardId,
        requestId,
        taskId: request.task_id,
        role: 'creator',
        summary: `A new quote arrived on your request ${requestId}.`,
        url: `${base}/request/${encodeURIComponent(requestId)}`,
        next: { tool: 'list_quotes', args: { requestId } },
        occurredAt: now,
      },
    ]
  }
  if (tool === 'apply') {
    const target = task(text(args.taskId)),
      applicationId = text(result.applicationId)
    if (target === undefined || applicationId === undefined) return []
    return [
      {
        id: `board:${boardId}:application:${applicationId}`,
        address: target.creator,
        kind: 'application.received',
        boardId,
        taskId: target.id,
        ...requestLink(target.id),
        jobId: target.job_id,
        role: 'creator',
        summary: `An agent applied to your task ${target.id}.`,
        url: jobUrl(target),
        next: { tool: 'list_applications', args: { taskId: target.id } },
        occurredAt: now,
      },
    ]
  }
  if (tool === 'submit_selection') {
    const target = task(text(args.taskId)),
      nonce = text(args.nonce),
      worker = text(result.worker)
    if (target === undefined || nonce === undefined || worker === undefined) return []
    return [
      {
        id: `board:${boardId}:selection:${target.id}:${nonce}`,
        address: worker,
        kind: 'selection.received',
        boardId,
        taskId: target.id,
        ...requestLink(target.id),
        jobId: target.job_id,
        role: 'worker',
        summary: `You were selected for task ${target.id}; activate the agreement to accept the job.`,
        url: jobUrl(target),
        next: { tool: 'prepare_activation', args: { taskId: target.id } },
        occurredAt: now,
      },
    ]
  }
  if (tool === 'request_quotes') {
    const requestId = text(result.requestId)
    if (requestId === undefined) return []
    const row = board.all<{ creator: string; invited_wallet: string | null }>(
      'SELECT creator, invited_wallet FROM quote_requests WHERE id = ?',
      requestId,
    )[0]
    const creator = row?.creator
    const invited = row?.invited_wallet
    return [
      ...[PUBLIC_ADDRESS, ...(creator === undefined ? [] : [creator])].map((address) => ({
        id: `board:${boardId}:request:${requestId}${address === PUBLIC_ADDRESS ? '' : ':creator'}`,
        address,
        kind: 'request.opened',
        boardId,
        requestId,
        role: address === PUBLIC_ADDRESS ? 'public' : 'creator',
        summary: `A new quote request ${requestId} is open.`,
        url: `${base}/request/${encodeURIComponent(requestId)}`,
        next: { tool: address === PUBLIC_ADDRESS ? 'submit_quote' : 'list_quotes', args: { requestId } },
        occurredAt: now,
      })),
      ...(invited === null || invited === undefined
        ? []
        : [
            {
              id: `board:${boardId}:request:${requestId}:invited`,
              address: invited,
              kind: 'quote.invited',
              boardId,
              requestId,
              role: 'invited',
              summary: `You were invited to quote on request ${requestId}.`,
              url: `${base}/request/${encodeURIComponent(requestId)}`,
              next: { tool: 'submit_quote', args: { requestId } },
              occurredAt: now,
            },
          ]),
    ]
  }
  if (tool === 'report_transaction') {
    // An invitation is news once its offer is escrowed on chain, not when the creator only prepared it.
    const target = task(text(args.taskId))
    if (target === undefined || target.job_id === null) return []
    return board
      .all<{ worker: string }>(
        "SELECT worker FROM applications WHERE task_id = ? AND (note = 'direct hire invitation' OR note LIKE 'picked quote %')",
        target.id,
      )
      .map(({ worker }) => ({
        id: `board:${boardId}:invite:${target.id}:${worker.toLowerCase()}`,
        address: worker,
        kind: 'invite.received',
        boardId,
        taskId: target.id,
        jobId: target.job_id,
        ...requestLink(target.id),
        role: 'invited',
        summary: `You were hired directly for job #${target.job_id}; the creator selects you next.`,
        url: jobUrl(target),
        next: { tool: 'get_task', args: { taskId: target.id } },
        occurredAt: now,
      }))
  }
  return []
}

/** Writes the tool's feed rows and Telegram notices; logs and swallows every failure. */
export async function recordBoardEvent(board: Sql, d1: AsyncSql, input: BoardToolEvent): Promise<void> {
  try {
    const events = boardFeedEvents(board, input)
    await writeFeed(d1, input.network, events, input.now)
    for (const event of events) {
      if (event.kind === 'quote.invited')
        await enqueueWalletNotification(d1, input.network, event.address, {
          id: `telegram:${event.id}`,
          text: `${event.summary} ${event.url}`,
          now: input.now,
        })
      if (event.kind === 'selection.received')
        await enqueueWalletNotification(d1, input.network, event.address, {
          id: `telegram:selected:${input.boardId}:${event.taskId}:${String(input.args.nonce)}`,
          text: `You were selected for Sidequest task ${event.taskId}. Activate the agreement to accept the job.`,
          now: input.now,
        })
      if (event.kind === 'request.opened' && event.role === 'public')
        await enqueuePublicRequest(d1, telegramPublicChannel(input.network), {
          boardId: input.boardId,
          taskId: event.requestId!,
          kind: 'quotes',
          network: input.network,
          now: input.now,
          ...(typeof input.args.title === 'string' ? { title: input.args.title } : {}),
        })
    }
  } catch (error) {
    reportFeedFailure(error)
  }
}
