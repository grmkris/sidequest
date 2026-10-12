/**
 * Signatures that say what they do (11 Oct showcase: Privy showed raw DelegationManager typed data). With Privy, its
 * screen shows the prompt's title, description and button; another wallet, or a deploy without Privy, signs through
 * wagmi as before. Either way the person still confirms.
 */
import { useCallback } from 'react'
import {
  type Hex,
  type TypedDataDefinition,
  getTypesForEIP712Domain,
  serializeTypedData,
  validateTypedData,
} from 'viem'
import { useSendTransaction, useSignTypedData } from 'wagmi'
import { type WalletPrompt, usePrivyPromptWallet } from './components/Privy.tsx'
import type { walletStepRequest } from './components/txOperation.ts'

export type { WalletPrompt }
/** A transaction's screen has no title of its own: Privy names the network and the amount. */
export type TxPrompt = Pick<WalletPrompt, 'description' | 'buttonText'>

/**
 * Typed data exactly as viem sends a JSON-RPC wallet (`eth_signTypedData_v4`): the EIP712Domain type derived from the
 * domain, validated, then serialized. Without that type a wallet hashes an empty domain and signs something else.
 */
export function walletTypedData(typedData: TypedDataDefinition): string {
  const types = { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types }
  // SAFETY: the same definition with the domain's type added, as viem's signTypedData adds it; validated just below.
  const full = { ...typedData, types } as TypedDataDefinition
  validateTypedData(full)
  return serializeTypedData(full)
}

export function useSignTypedDataWithPrompt() {
  const privy = usePrivyPromptWallet()
  const { mutateAsync: signTypedDataAsync } = useSignTypedData()
  return useCallback(
    // What wagmi would send the wallet, so the signature is the one it would have asked for.
    async (typedData: TypedDataDefinition, prompt: WalletPrompt): Promise<Hex> =>
      privy === null ? signTypedDataAsync(typedData) : privy.signTypedData(walletTypedData(typedData), prompt),
    [privy, signTypedDataAsync],
  )
}

/** One journaled step from the login wallet with its prompt on Privy's screen; another wallet sends through wagmi. */
export function useSendTransactionWithPrompt() {
  const privy = usePrivyPromptWallet()
  const { mutateAsync: sendTransactionAsync } = useSendTransaction()
  return useCallback(
    async (request: ReturnType<typeof walletStepRequest> & { gas?: bigint }, prompt: TxPrompt): Promise<Hex> => {
      if (privy === null || privy.address.toLowerCase() !== request.account.toLowerCase())
        return sendTransactionAsync(request)
      const { to, data, value, nonce, gas } = request
      return privy.sendTransaction(
        { to, data, value, ...(nonce === undefined ? {} : { nonce }), ...(gas === undefined ? {} : { gas }) },
        prompt,
      )
    },
    [privy, sendTransactionAsync],
  )
}

/**
 * What a transaction does, from its steps' own descriptions. A call the wallet sends to itself runs the steps inside
 * it, so the screen says so (11 Oct showcase: backing showed only "To: your own address").
 */
export function stepsPrompt(steps: readonly { description: string }[], toSelf: boolean): TxPrompt {
  const said = steps.map((step) => step.description.replace(/\.$/, ''))
  const what = said.length === 1 ? `${said[0]}.` : `${said.length} steps in one transaction: ${said.join('; ')}.`
  return {
    description: toSelf ? `${what} Your wallet sends this to itself and runs it in one go.` : what,
    buttonText: 'Send',
  }
}

/** What each signature says on Privy's screen: what it allows, who it is for and its limit, never the raw typed data. */
export const prompts = {
  registration: (agent: string): WalletPrompt => ({
    title: `Register ${agent}`,
    description: `Registers ${agent}'s Agent ID to your wallet. Sidequest sends it and pays the gas; this signature allows that one registration and nothing else.`,
    buttonText: 'Register',
  }),
  weeklyBudget: (agent: string, amount: string): WalletPrompt => ({
    title: `Set ${agent}'s weekly budget`,
    description: `${agent} may pay up to ${amount} a week from your wallet to hire. The chain enforces the limit, and you can change it any time.`,
    buttonText: 'Set budget',
  }),
  hire: (agent: string, amount: string): WalletPrompt => ({
    title: 'Approve this hire',
    description: `${agent} may pay exactly ${amount} from your wallet for this one hire, once.`,
    buttonText: 'Approve hire',
  }),
  permission: (agent: string, what: string): WalletPrompt => ({
    title: `Grant ${agent} a permission`,
    description: `${what} The chain enforces every limit, and you can revoke it on ${agent}'s page.`,
    buttonText: 'Grant permission',
  }),
  jobBudget: (cap: string): WalletPrompt => ({
    title: 'Grant the job budget',
    description: `The agent on this job may spend up to ${cap} from your wallet, for this job only. Nothing moves now, and the chain enforces the cap.`,
    buttonText: 'Grant budget',
  }),
  sponsorship: (): WalletPrompt => ({
    title: 'Let Sidequest pay your gas',
    description:
      "Sidequest's relay may send your Sidequest transactions and pay their gas, within the limits shown. You can turn it off any time.",
    buttonText: 'Turn on',
  }),
  selection: (agent: string): WalletPrompt => ({
    title: `Select ${agent}`,
    description: `Chooses ${agent} for this job, which it starts on chain with this signature. The reward is paid when you accept the delivery, or when its review window ends without a reply.`,
    buttonText: 'Select',
  }),
  backingPermit: (agent: string, amount: string): WalletPrompt => ({
    title: `Back ${agent}`,
    description: `Lets the staking vault take ${amount} SIDE from your wallet to back ${agent}. It is valid for one hour, and the next step sends it.`,
    buttonText: 'Sign',
  }),
}
