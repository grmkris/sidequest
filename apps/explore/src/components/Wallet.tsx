import { Button } from './ui/button.tsx'
import { cn } from '../lib/cn.ts'
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { session, setSession, tool } from '../api.ts'
import { askedKey, isRefusal, silentSignable } from '../sign-in.ts'
import { chain } from '../wallet.ts'
import { PrivyLogin, usePrivyLogout, usePrivyModalOpen, usePrivySilentSigner } from './Privy.tsx'

/** Which address the stored session belongs to, and until when (seconds): a session outlives the tab now. */
const OWNER_KEY = 'sidequest.session-owner'
type Owner = { address: string; expiresAt: number }
function readOwner(): Owner | null {
  try {
    return JSON.parse(localStorage.getItem(OWNER_KEY) ?? 'null') as Owner | null
  } catch {
    return null
  }
}
function writeOwner(owner: Owner | null) {
  try {
    if (owner === null) localStorage.removeItem(OWNER_KEY)
    else localStorage.setItem(OWNER_KEY, JSON.stringify(owner))
  } catch {
    // storage blocked: the session then lasts this tab only
  }
}

/**
 * Log in with Privy (email or social; an embedded wallet), then sign in to the board with SIWE (one signature). The
 * session counts only for the address that signed it and until it expires; a different wallet signs in afresh.
 */
export function useSignedIn() {
  const { address } = useAccount()
  const [token, setToken] = useState(session())
  const [owner, setOwner] = useState(readOwner())
  const { signMessageAsync } = useSignMessage()
  const silentSigner = usePrivySilentSigner()
  /** `silent` signs a checked sign-in message without the wallet's screen (the automatic sign-in after a login). */
  const signIn = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (address === undefined) throw new Error('log in first')
    const { message } = await tool<{ message: string }>('auth_challenge', { address })
    const signature =
      silent && silentSigner !== null && silentSignable(message, { address, host: location.host, chainId: chain.id })
        ? await silentSigner(address, message)
        : await signMessageAsync({ message })
    const r = await tool<{ session: string; address: string; expiresAt: number }>('auth_login', { message, signature })
    setSession(r.session)
    setToken(r.session)
    const o = { address: r.address, expiresAt: r.expiresAt }
    writeOwner(o)
    setOwner(o)
  }
  const signOut = () => {
    setSession(null)
    setToken(null)
    writeOwner(null)
    setOwner(null)
  }
  const ours =
    token !== null &&
    address !== undefined &&
    owner !== null &&
    owner.address.toLowerCase() === address.toLowerCase() &&
    owner.expiresAt * 1000 > Date.now()
  return { address, signedIn: ours, signIn, signOut }
}

const AuthContext = createContext<ReturnType<typeof useSignedIn> | null>(null)

/** One sign-in state for the whole app (the header and every page see the same session). */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <AuthContext value={useSignedIn()}>{children}</AuthContext>
}

export function useAuth() {
  const auth = useContext(AuthContext)
  if (auth === null) throw new Error('useAuth outside AuthProvider')
  return auth
}

/**
 * Right after logging in, asks once per address and tab for the board's sign-in signature (declining leaves a Sign in
 * button). Call it once, in the shell; the account controls only display its state.
 */
export function useAutoSignIn(auth: ReturnType<typeof useSignedIn>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Whether the sign-in ran to an answer: signed, or refused by the person (a fault leaves it to ask again). */
  const signIn = async (silent = false): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await auth.signIn({ silent })
      return true
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? 'sign-in failed')
      return isRefusal(e)
    } finally {
      setBusy(false)
    }
  }
  const asked = useRef(new Set<string>())
  // A new user's wallet appears while Privy still shows its "wallet created" screen, and that screen stays mounted
  // while it closes. So the automatic sign-in waits for the modal and then signs without Privy's screen, which would
  // otherwise replace the closing screen's data and crash it.
  const privyModal = usePrivyModalOpen()
  useEffect(() => {
    const a = auth.address?.toLowerCase()
    if (a === undefined || auth.signedIn || privyModal || asked.current.has(a)) return
    asked.current.add(a)
    try {
      if (sessionStorage.getItem(askedKey(a)) !== null) return
    } catch {
      // no sessionStorage: ask once per page load
    }
    // Remembered only once answered, so a crash or a dropped request mid-way asks again after a reload.
    void signIn(true).then((answered) => {
      try {
        if (answered) sessionStorage.setItem(askedKey(a), '1')
      } catch {
        // no sessionStorage: the page-load memory above still applies
      }
    })
  }, [auth.address, auth.signedIn, privyModal])
  return { busy, error, signIn }
}

export type AutoSignIn = ReturnType<typeof useAutoSignIn>

/** Signs out of the board and of Privy, and disconnects the wallet. */
export function useSignOut(auth: ReturnType<typeof useSignedIn>) {
  const { disconnect } = useDisconnect()
  const privyLogout = usePrivyLogout()
  return () => {
    auth.signOut()
    disconnect()
    void privyLogout()
  }
}

/**
 * Who is signed in, compactly: the login button, a Sign in button when the signature is still missing, or the
 * address. `full` adds Sign out (the sidebar); on a phone the address links to Me, where signing out lives.
 */
export function AccountControl({
  auth,
  account,
  full = false,
}: {
  auth: ReturnType<typeof useSignedIn>
  account: AutoSignIn
  full?: boolean
}) {
  const signOut = useSignOut(auth)
  if (auth.address === undefined) return <PrivyLogin />
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {auth.signedIn ? (
        // The link is the 44 px target; the pill inside it is what shows.
        <Link to="/account" className="flex min-h-11 min-w-0 items-center" aria-label="Your wallet">
          <span className="flex min-w-0 items-center gap-2 rounded-full bg-muted py-1 pr-3 pl-1 text-ui font-medium">
            <Monogram seed={auth.address} />
            <span className="truncate font-mono text-ui">
              {auth.address.slice(0, 6)}…{auth.address.slice(-4)}
            </span>
          </span>
        </Link>
      ) : (
        <Button busy={account.busy} size="sm" onClick={() => void account.signIn()}>
          Sign in
        </Button>
      )}
      {/* Always a way out, even when the signature was declined. */}
      {full && (
        <Button variant="link" size="sm" onClick={signOut}>
          Sign out
        </Button>
      )}
      {account.error !== null && <span className="basis-full text-xs text-destructive-text">{account.error}</span>}
    </div>
  )
}

/** A round colour mark derived from an address or agent id, for people and agents without a picture. */
export function Monogram({ seed, label, size = 'sm' }: { seed: string; label?: string; size?: 'sm' | 'md' | 'lg' }) {
  // FNV-1a spreads neighbouring seeds (agent 1942, 1943…) across the colour wheel.
  let x = 0x811c9dc5
  for (const c of seed.toLowerCase()) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193)
  const h = (x >>> 0) % 360
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-bold text-white',
        size === 'sm' && 'size-6 text-micro',
        size === 'md' && 'size-9 text-xs',
        size === 'lg' && 'size-16 text-lg',
      )}
      style={{ background: `linear-gradient(140deg, hsl(${h} 62% 56%), hsl(${(h + 40) % 360} 58% 44%))` }}
    >
      {label ?? ''}
    </span>
  )
}
