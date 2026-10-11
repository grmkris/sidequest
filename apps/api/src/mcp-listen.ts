/**
 * The MCP 2026-07-28 `subscriptions/listen` streams the management Durable Object holds (ADR-0021). A connection that
 * listens with `toolsListChanged` is told the moment its tools change: roles, approval, setup binding, disconnect.
 */
const encoder = new TextEncoder()
const SUBSCRIPTION = 'io.modelcontextprotocol/subscriptionId'

export interface ListenRequest {
  /** The listen request's JSON-RPC id, which names the subscription. */
  readonly subscriptionId: string | number
  readonly notifications: { readonly toolsListChanged?: boolean }
}

interface Listener {
  readonly subscriptionId: string | number
  readonly tools: boolean
  readonly opened: number
  readonly send: (frame: string) => boolean
  readonly end: () => void
}

const frame = (message: Record<string, unknown>) => `data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`
const notice = (method: string, subscriptionId: string | number, params: Record<string, unknown> = {}) =>
  frame({ method, params: { ...params, _meta: { [SUBSCRIPTION]: subscriptionId } } })

export class McpListeners {
  readonly #byGrant = new Map<string, Set<Listener>>()
  /** Each listening connection's access when it was last told: what its tools/list depends on. */
  readonly #access = new Map<string, string>()

  constructor(
    readonly options: { now: () => number; maxPerGrant?: number; lifetimeMs?: number } = { now: () => Date.now() },
  ) {}

  /** Opens a stream: the acknowledgment first, then a tools notice at once, because its list just became exact. */
  open(grantId: string, request: ListenRequest, access: string): Response {
    const tools = request.notifications.toolsListChanged === true
    this.#access.set(grantId, access)
    const listeners = this.#byGrant.get(grantId) ?? new Set<Listener>()
    this.#byGrant.set(grantId, listeners)
    // A client re-listening after a lost stream must not be refused: the oldest stream gives way.
    const oldest = [...listeners].toSorted((a, b) => a.opened - b.opened)
    for (const stale of oldest.slice(0, Math.max(0, oldest.length - (this.options.maxPerGrant ?? 4) + 1)))
      this.#drop(grantId, stale, true)
    let listener: Listener | undefined
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true
        listener = {
          subscriptionId: request.subscriptionId,
          tools,
          opened: this.options.now(),
          send: (text) => {
            if (!open) return false
            try {
              controller.enqueue(encoder.encode(text))
              return true
            } catch {
              open = false
              return false
            }
          },
          end: () => {
            if (!open) return
            open = false
            try {
              controller.close()
            } catch {
              // The client cancelled the stream first; there is nothing left to close.
            }
          },
        }
        listeners.add(listener)
        listener.send(
          notice('notifications/subscriptions/acknowledged', request.subscriptionId, {
            notifications: tools ? { toolsListChanged: true } : {},
          }),
        )
        if (tools) listener.send(notice('notifications/tools/list_changed', request.subscriptionId))
      },
      cancel: () => {
        if (listener !== undefined) this.#drop(grantId, listener, true)
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    })
  }

  /** Whether this connection holds a stream that hears tool changes, so its tools/list can be exact. */
  listening(grantId: string): boolean {
    return [...(this.#byGrant.get(grantId) ?? [])].some((listener) => listener.tools)
  }

  toolsChanged(grantIds: readonly string[]): void {
    for (const grantId of grantIds)
      for (const listener of this.#byGrant.get(grantId) ?? [])
        if (listener.tools && !listener.send(notice('notifications/tools/list_changed', listener.subscriptionId)))
          this.#drop(grantId, listener, true)
  }

  /**
   * After anything that may change access: a connection whose access changed hears that its tools changed, and one
   * that no longer exists (disconnected, revoked, stopped) has its streams ended for good.
   */
  sync(access: (grantId: string) => string | undefined): void {
    // A copy: closing a connection removes it from the map being walked.
    for (const grantId of Array.from(this.#byGrant.keys())) {
      const now = access(grantId)
      if (now === undefined) this.close([grantId])
      else if (now !== this.#access.get(grantId)) {
        this.#access.set(grantId, now)
        this.toolsChanged([grantId])
      }
    }
  }

  /** Whether any stream is open, so the keepalive timer can stop when none is. */
  active(): boolean {
    return this.#byGrant.size > 0
  }

  /** Ends these connections' streams for good: a final response, so clients know not to listen again. */
  close(grantIds: readonly string[]): void {
    for (const grantId of grantIds)
      for (const listener of this.#byGrant.get(grantId) ?? []) this.#drop(grantId, listener)
  }

  /** Every 25 s: a comment keeps idle streams open, and streams past their lifetime close so clients re-listen. */
  keepalive(): void {
    const expired = this.options.now() - (this.options.lifetimeMs ?? 3_600_000)
    for (const [grantId, listeners] of this.#byGrant)
      for (const listener of listeners)
        if (listener.opened <= expired || !listener.send(':\n\n')) this.#drop(grantId, listener, true)
  }

  #drop(grantId: string, listener: Listener, abrupt = false): void {
    if (!abrupt)
      listener.send(
        frame({
          id: listener.subscriptionId,
          result: { resultType: 'complete', _meta: { [SUBSCRIPTION]: listener.subscriptionId } },
        }),
      )
    listener.end()
    const listeners = this.#byGrant.get(grantId)
    listeners?.delete(listener)
    if (listeners?.size !== 0) return
    this.#byGrant.delete(grantId)
    this.#access.delete(grantId)
  }
}
