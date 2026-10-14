// An actor has an EVM wallet (money, EIP-712 authority, ERC-8004 identity) and a separate Nostr key
// (the wire). Wallets cannot sign Nostr events, so the two are linked by a signature in each direction.
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { type Address, type PrivateKeyAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

export const KIND = {
  REQUEST: 30500, // public, addressable: a job request and its shape
  LINK: 30501, // public, addressable: this Nostr key speaks for that wallet / agent
  CHANNEL: 4500, // a job's channel; relay-gated to the job's participants
} as const

export interface Actor {
  name: string
  owner: string
  account: PrivateKeyAccount
  address: Address
  nostrSk: Uint8Array
  nostrPk: string
  agentId: bigint
}

export function makeActor(name: string, owner: string): Actor {
  const account = privateKeyToAccount(generatePrivateKey())
  const nostrSk = generateSecretKey()
  return { name, owner, account, address: account.address, nostrSk, nostrPk: getPublicKey(nostrSk), agentId: 0n }
}

export const linkMessage = (nostrPk: string, agentId: bigint) => `sidequest-link:${nostrPk}:${agentId}`

export async function linkEvent(actor: Actor, at: number) {
  const evmSig = await actor.account.signMessage({ message: linkMessage(actor.nostrPk, actor.agentId) })
  return finalizeEvent(
    {
      kind: KIND.LINK,
      created_at: at,
      tags: [['d', 'sidequest-link']],
      content: JSON.stringify({ agentId: actor.agentId.toString(), wallet: actor.address, evmSig }),
    },
    actor.nostrSk,
  )
}
