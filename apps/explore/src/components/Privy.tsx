import { Button } from './ui/button.tsx'
import * as sdk from '@sidequest/sdk'
import {
  PrivyProvider,
  usePrivy,
  useSign7702Authorization,
  useSendTransaction as usePrivySendTransaction,
  useSignMessage,
  useSignTypedData as usePrivySignTypedData,
  useWallets,
} from '@privy-io/react-auth'
import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { type EIP1193Provider, type Hex, createPublicClient, http, isHex, toHex } from 'viem'
import { useConnect } from 'wagmi'
import { type TxRequest, tool } from '../api.ts'
import { chain, deployment, privyAppId, setPrivyProvider } from '../wallet.ts'
import { silentSignable } from '../sign-in.ts'

/**
 * The site's only sign-in: email or social login (whatever the Privy dashboard enables: email, Google, X…) with a
 * Privy embedded wallet. Privy creates and holds the wallet; the app uses it for SIWE board sign-in, transaction
 * steps (batched through EIP-7702, the upgrade relayed by the board) and granting an execution budget.
 * People fund it from their own wallets. Absent when the deploy has no PRIVY_APP_ID (the site is then read-only).
 */
/** The deploy's chain in Privy's shape (its type is stricter than viem's about optional fields). */
const privyChain = {
  id: chain.id,
  name: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: { default: { http: [...chain.rpcUrls.default.http] } },
  blockExplorers: {
    default: chain.blockExplorers?.default ?? { name: 'Monadscan', url: 'https://monadscan.com' },
  },
}

export function PrivyRoot({ children }: { children: ReactNode }) {
  if (privyAppId === '') return children
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        // Create the operator wallet at login; the server creates each agent wallet.
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' } },
        defaultChain: privyChain,
        supportedChains: [privyChain],
      }}
    >
      <OperatorBridge>{children}</OperatorBridge>
    </PrivyProvider>
  )
}

/**
 * Signs a message with the login wallet without Privy's screen. Only for messages the caller has checked (the board's
 * sign-in, see sign-in.ts); null without Privy.
 */
export type SilentSigner = (address: string, message: string) => Promise<Hex>

/**
 * Signs without Privy's screen for the login wallet only, and only a message that is this site's own board sign-in:
 * the signer checks that itself, whoever calls it.
 */
function silentSigner(
  address: string | undefined,
  signMessage: ReturnType<typeof useSignMessage>['signMessage'],
): SilentSigner {
  return async (signer, message) => {
    if (address === undefined || signer.toLowerCase() !== address.toLowerCase())
      throw new Error('Only the login wallet signs without a prompt.')
    if (!silentSignable(message, { address, host: location.host, origin: location.origin, chainId: chain.id }))
      throw new Error('Only the board sign-in for this site signs without a prompt.')
    const { signature } = await signMessage({ message }, { address, uiOptions: { showWalletUIs: false } })
    if (!isHex(signature)) throw new Error('The wallet returned no signature.')
    return signature
  }
}
const SilentSignerContext = createContext<SilentSigner | null>(null)

export function usePrivySilentSigner(): SilentSigner | null {
  return useContext(SilentSignerContext)
}

/** What Privy's screen says for one signature: what it does, in the person's words, and the button that gives it. */
export interface WalletPrompt {
  title: string
  description: string
  buttonText: string
}

/** One transaction from the login wallet, as TxSteps journals it: the exact nonce and gas limit it chose. */
interface PromptedTransaction {
  to: Hex
  data: Hex
  value: bigint
  nonce?: number
  gas?: bigint
}

/**
 * The login wallet on Privy's own screens, with a prompt in place of a bare "Sign" or a bare transaction. `signTypedData`
 * takes viem's `serializeTypedData` output (what wagmi sends a wallet). Null without Privy or before login.
 */
export interface PromptWallet {
  address: string
  signTypedData(typedData: string, prompt: WalletPrompt): Promise<Hex>
  sendTransaction(tx: PromptedTransaction, prompt: Pick<WalletPrompt, 'description' | 'buttonText'>): Promise<Hex>
}
const PromptWalletContext = createContext<PromptWallet | null>(null)

export function usePrivyPromptWallet(): PromptWallet | null {
  return useContext(PromptWalletContext)
}

/** Privy's transaction screen: the step's own description, our button, and the deploy's chain. */
function privyTransaction(tx: PromptedTransaction) {
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value,
    chainId: chain.id,
    ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }),
    ...(tx.gas === undefined ? {} : { gasLimit: tx.gas }),
  }
}

/** Connect the login wallet only. No agent address can be selected through wagmi. */
function OperatorBridge({ children }: { children: ReactNode }) {
  const { authenticated, user } = usePrivy()
  const { wallets } = useWallets()
  const { signMessage } = useSignMessage()
  const { signTypedData } = usePrivySignTypedData()
  const { sendTransaction } = usePrivySendTransaction()
  const { connectors, connectAsync } = useConnect()
  const connected = useRef<string | undefined>(undefined)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const primary = user?.linkedAccounts.find(
    (account) =>
      account.type === 'wallet' &&
      account.walletClientType === 'privy' &&
      (account.walletIndex === 0 || account.walletIndex === null),
  )
  const address = primary?.type === 'wallet' ? primary.address : undefined
  const currentAddress = useRef(address)
  currentAddress.current = authenticated ? address : undefined
  const operator = wallets.find((wallet) => wallet.address.toLowerCase() === address?.toLowerCase())
  useEffect(() => {
    if (!authenticated) {
      connected.current = undefined
      setPrivyProvider(undefined)
      return
    }
    if (operator === undefined || pending.current || connected.current === address) return
    pending.current = true
    async function connectOperator() {
      await operator!.switchChain(chain.id)
      const provider = await operator!.getEthereumProvider()
      if (currentAddress.current !== address) return
      const connector = connectors.find((candidate) => candidate.id === 'privy')
      if (connector === undefined) throw new Error('The operator wallet connector is unavailable.')
      setPrivyProvider(provider as EIP1193Provider)
      await connectAsync({ connector })
      connected.current = address
    }
    void connectOperator()
      .catch((failure: unknown) => {
        if (currentAddress.current === address)
          setError(failure instanceof Error ? failure.message : 'Operator wallet connection failed.')
      })
      .finally(() => {
        pending.current = false
      })
  }, [authenticated, address, operator?.address, connectAsync])
  const signSilently = silentSigner(address, signMessage)
  const promptWallet = useMemo<PromptWallet | null>(() => {
    if (!authenticated || address === undefined) return null
    return {
      address,
      signTypedData: async (typedData, prompt) => {
        // SAFETY: the caller serialized it with viem's serializeTypedData, which validated it as EIP-712 typed data.
        const input = JSON.parse(typedData) as Parameters<typeof signTypedData>[0]
        const { signature } = await signTypedData(input, { address, uiOptions: prompt })
        if (!isHex(signature)) throw new Error('The wallet returned no signature.')
        return signature
      },
      sendTransaction: async (tx, prompt) => {
        const { hash } = await sendTransaction(privyTransaction(tx), { address, uiOptions: prompt })
        return hash
      },
    }
  }, [authenticated, address, signTypedData, sendTransaction])
  return (
    <SilentSignerContext value={signSilently}>
      <PromptWalletContext value={promptWallet}>
        {error !== null && <p role="alert">{error}</p>}
        {children}
      </PromptWalletContext>
    </SilentSignerContext>
  )
}

/** The only way in: Privy's login (email or social). Without a Privy app the site is read-only. */
export function PrivyLogin() {
  if (privyAppId === '') return <span className="text-xs text-muted-foreground">read-only</span>
  return <PrivyLoginButton />
}

function PrivyLoginButton() {
  const { ready, authenticated, login } = usePrivy()
  if (authenticated) return null
  return (
    <Button disabled={!ready} onClick={() => login()}>
      Sign in
    </Button>
  )
}

/** Logs out of Privy too when the user signs out (no-op without Privy). */
export function usePrivyLogout(): () => Promise<void> {
  if (privyAppId === '') return async () => {}
  // biome-ignore lint: the branch above is a build-time constant, so hook order never changes.
  const { authenticated, logout } = usePrivy()
  return async () => {
    if (authenticated) await logout()
  }
}

/** Whether Privy's own modal is showing (false without Privy). */
export function usePrivyModalOpen(): boolean {
  if (privyAppId === '') return false
  // biome-ignore lint: the branch above is a build-time constant, so hook order never changes.
  return usePrivy().isModalOpen
}

/**
 * Several transactions as one from the Privy embedded wallet (EIP-7702): a call to ERC-7579 `execute` on the wallet
 * itself, once the wallet points at the deployment's DeleGator (the first batch upgrades it through the board's
 * relay). All or nothing, one confirmation. Null without Privy or for another wallet.
 */
export type BatchSend = ((
  txs: TxRequest[],
  gas?: bigint,
  nonce?: number,
  prompt?: Pick<WalletPrompt, 'description' | 'buttonText'>,
) => Promise<Hex>) & {
  /** Finish any authorization transaction before the caller captures the funding nonce. */
  prepare?: () => Promise<void>
}

export function usePrivyBatch(address: string | undefined): BatchSend | null {
  const account = useDelegatorAccount(address)
  if (account === null) return null
  const send: BatchSend = (txs, gas, nonce, prompt) =>
    account.send(sdk.batchCalldata(txs.map((t) => ({ ...t, value: '0' as const }))), gas, nonce, prompt)
  send.prepare = async () => {
    const hash = await account.upgrade()
    if (hash !== null && (await reads.waitForTransactionReceipt({ hash })).status !== 'success')
      throw new Error('Wallet upgrade reverted. No funding steps were sent.')
    if (!(await account.delegated()))
      throw new Error('Wallet upgrade is not confirmed. Reconcile it before sending funding.')
  }
  return send
}

/**
 * Points the Privy embedded wallet's code at the deployment's DeleGator when it is not there yet: what a creator does
 * once before granting an execution budget. Resolves to the relay's transaction hash, or null when nothing had to be
 * sent. Null without Privy or for another wallet.
 */
export function useDelegatorUpgrade(address: string | undefined): (() => Promise<Hex | null>) | null {
  const account = useDelegatorAccount(address)
  if (account === null) return null
  return account.upgrade
}

const reads = createPublicClient({ chain, transport: http() })

interface DelegatorAccount {
  delegated(): Promise<boolean>
  /** The DeleGator upgrade when the code is not there yet: the relay's transaction hash, or null. */
  upgrade(): Promise<Hex | null>
  /**
   * A call to self, after the upgrade when it is still needed; `gas` when the calls need more than an estimate. With a
   * prompt, Privy's screen says what the call does instead of only "To: your own address".
   */
  send(data: Hex, gas?: bigint, nonce?: number, prompt?: Pick<WalletPrompt, 'description' | 'buttonText'>): Promise<Hex>
}

function useDelegatorAccount(address: string | undefined): DelegatorAccount | null {
  if (privyAppId === '') return null
  // biome-ignore lint: the branch above is a build-time constant, so hook order never changes.
  return useDelegatorAccountInner(address)
}

function useDelegatorAccountInner(address: string | undefined): DelegatorAccount | null {
  const { authenticated } = usePrivy()
  const { wallets } = useWallets()
  const { signAuthorization } = useSign7702Authorization()
  const promptWallet = usePrivyPromptWallet()
  const embedded = wallets.find(
    (wallet) => wallet.walletClientType === 'privy' && wallet.address.toLowerCase() === address?.toLowerCase(),
  )
  if (
    !authenticated ||
    embedded === undefined ||
    address === undefined ||
    embedded.address.toLowerCase() !== address.toLowerCase()
  )
    return null
  const me = embedded.address as Hex
  const delegate = deployment.delegation.delegator
  const delegated = async () => {
    const current = await sdk.delegationOf(reads, me)
    return current !== null && current.toLowerCase() === delegate.toLowerCase()
  }
  // Privy's embedded wallets run in Privy's TEE, whose transaction signing drops `authorizationList`: the wallet signs
  // the authorization (for its current nonce, since it does not send the transaction) and the board's relay sends it.
  const upgrade = async (): Promise<Hex | null> => {
    if (await delegated()) return null
    const nonce = await reads.getTransactionCount({ address: me, blockTag: 'pending' })
    const a = await signAuthorization({ contractAddress: delegate, chainId: chain.id, nonce }, { address: me })
    const r = await tool<{ txHash: Hex | null }>('upgrade_account', {
      authorization: {
        address: a.address,
        chainId: a.chainId,
        nonce: a.nonce,
        r: a.r,
        s: a.s,
        yParity: a.yParity,
      },
    })
    return r.txHash
  }
  return {
    delegated,
    upgrade,
    send: async (data, gas, nonce, prompt) => {
      if (!(await delegated())) throw new Error('Prepare the wallet upgrade before capturing the send nonce.')
      if (prompt !== undefined && promptWallet?.address.toLowerCase() === me.toLowerCase())
        return promptWallet.sendTransaction(
          { to: me, data, value: 0n, ...(gas === undefined ? {} : { gas }), ...(nonce === undefined ? {} : { nonce }) },
          prompt,
        )
      const provider = (await embedded.getEthereumProvider()) as EIP1193Provider
      const request = {
        from: me,
        to: me,
        data,
        value: '0x0',
        chainId: toHex(chain.id),
        ...(gas === undefined ? {} : { gas: toHex(gas) }),
        ...(nonce === undefined ? {} : { nonce: toHex(nonce) }),
      }
      return (await provider.request({
        method: 'eth_sendTransaction',
        params: [request as never],
      })) as Hex
    },
  }
}
