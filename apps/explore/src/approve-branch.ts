/**
 * Which branch the approve page shows, fixed by the agent's state when the page first saw it. Registering here makes
 * the agent `active`, and a refetch that lands before the automatic connect finishes must not swap the
 * register-and-connect flow for the manual Connect button: that unmounts the connect in flight and asks for a second
 * click.
 */
export function approveBranch(firstSeen: string | null, current: string): 'connect' | 'register' {
  return (firstSeen ?? current) === 'active' ? 'connect' : 'register'
}
