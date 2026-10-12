/**
 * The mainnet launch gate's pieces that do not depend on the page (PROD-GATE-006): which board tools only read, and a
 * wallet provider that refuses to send or sign while writes are closed. `wallet.ts` and `api.ts` apply them with
 * `writesOpen`; the pages show `LaunchGate`.
 */

export const LAUNCH_MESSAGE =
  'Sidequest on mainnet opens soon. Until launch you can look around, but nothing can be published, taken, backed or paid.'

/** Board tools that only read (the board's `readOnlyHostedTools`, plus Collect's list): the only ones allowed while writes are closed. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'protocol_info',
  'whoami',
  'list_tasks',
  'get_task',
  'list_quote_requests',
  'get_quote_request',
  'list_quotes',
  'get_budget',
  'task_index',
  'list_applications',
  'list_disputes',
  'get_dispute_bundle',
  'settlement_actions',
  'setup_status',
  'collect_actions',
  'list_boards',
  'get_board',
  'auth_challenge',
  'auth_login',
  'list_directory',
  'get_directory_agent',
  'telegram_status',
  'sponsor_status',
  'sponsor_operation',
  'fee_quote',
  'get_stake',
  'list_delegations',
  'list_messages',
  'list_gaps',
  'list_roadmap',
  'get_roadmap_item',
  'list_roles',
])

/** Whether a board tool may be called: any while writes are open, else only a read. Unknown tools count as writes. */
export const toolAllowed = (name: string, open: boolean) => open || READ_TOOLS.has(name)

/**
 * Wallet requests that send or sign something that acts on chain. Board sign-in (`personal_sign` of its challenge)
 * stays allowed: it reads who you are, and the pages that ask for any other message are closed.
 */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_signTransaction',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_sendCalls',
  'wallet_signAuthorization',
])

interface Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/** The provider itself while writes are open; otherwise the same provider, refusing every write request (EIP-1193 4100). */
export function closeWrites<P extends Provider>(provider: P | undefined, open: boolean): P | undefined {
  if (open || provider === undefined) return provider
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') {
        return (args: { method: string; params?: unknown }) =>
          WRITE_METHODS.has(args.method)
            ? Promise.reject(Object.assign(new Error(LAUNCH_MESSAGE), { code: 4100 }))
            : target.request(args)
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
