/**
 * Signatures that say what they do (11 Oct showcase: Privy showed raw DelegationManager typed data). With Privy, its
 * screen shows the prompt's title, description and button; another wallet, or a deploy without Privy, signs through
 * wagmi as before. Either way the person still confirms.
 */
import { useCallback } from 'react'
import { type Hex, type TypedDataDefinition, serializeTypedData } from 'viem'
import { useSignTypedData } from 'wagmi'
import { type WalletPrompt, usePrivyPromptSigner } from './components/Privy.tsx'

export type { WalletPrompt }

export function useSignTypedDataWithPrompt() {
  const privy = usePrivyPromptSigner()
  const { mutateAsync: signTypedDataAsync } = useSignTypedData()
  return useCallback(
    // The same serialization wagmi sends a JSON-RPC wallet, so the signature is the one it would have asked for.
    async (typedData: TypedDataDefinition, prompt: WalletPrompt): Promise<Hex> =>
      privy === null ? signTypedDataAsync(typedData) : privy(serializeTypedData(typedData), prompt),
    [privy, signTypedDataAsync],
  )
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
    description: `Chooses ${agent} for this job, which it starts on chain with this signature. Nothing is paid until you approve the delivery.`,
    buttonText: 'Select',
  }),
  backingPermit: (agent: string, amount: string): WalletPrompt => ({
    title: `Back ${agent}`,
    description: `Lets the staking vault take ${amount} SIDE from your wallet to back ${agent}. It is valid for one hour, and the next step sends it.`,
    buttonText: 'Sign',
  }),
}
