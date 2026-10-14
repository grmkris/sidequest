// EIP-712 messages that carry authority. Nostr signatures prove who said something on the wire;
// these prove it to the contract. Anything the chain or an arbitrator must rely on is signed here.
import { type Address, type Hex, type PrivateKeyAccount, recoverTypedDataAddress, zeroAddress } from 'viem'

export const domain = {
  name: 'SidequestV2Spike',
  version: '0',
  chainId: 143,
  verifyingContract: zeroAddress,
} as const

export const types = {
  SeatOffer: [
    { name: 'index', type: 'uint8' },
    { name: 'worker', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'price', type: 'uint256' },
  ],
  Quote: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'quoter', type: 'address' },
    { name: 'swarmId', type: 'uint256' },
    { name: 'offers', type: 'SeatOffer[]' },
    { name: 'expiry', type: 'uint64' },
  ],
  Seat: [
    { name: 'index', type: 'uint8' },
    { name: 'role', type: 'string' },
    { name: 'worker', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'reward', type: 'uint256' },
    { name: 'bond', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'judgeSeat', type: 'int16' },
    { name: 'dependsOn', type: 'uint8[]' },
    { name: 'required', type: 'bool' },
  ],
  Roster: [
    { name: 'jobId', type: 'bytes32' },
    { name: 'creator', type: 'address' },
    { name: 'shapeHash', type: 'bytes32' },
    { name: 'swarmId', type: 'uint256' },
    { name: 'arbitrator', type: 'address' },
    { name: 'activateBy', type: 'uint64' },
    { name: 'seats', type: 'Seat[]' },
  ],
  Reassign: [
    { name: 'jobId', type: 'bytes32' },
    { name: 'seat', type: 'uint8' },
    { name: 'worker', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Submission: [
    { name: 'jobId', type: 'bytes32' },
    { name: 'seat', type: 'uint8' },
    { name: 'deliverableHash', type: 'bytes32' },
    { name: 'transcriptRoot', type: 'bytes32' },
  ],
  Ruling: [
    { name: 'jobId', type: 'bytes32' },
    { name: 'seat', type: 'uint8' },
    { name: 'workerWins', type: 'bool' },
    { name: 'transcriptRoot', type: 'bytes32' },
  ],
} as const

export interface SeatOffer {
  index: number
  worker: Address
  agentId: bigint
  price: bigint
}
export interface Quote {
  requestId: Hex
  quoter: Address
  swarmId: bigint
  offers: SeatOffer[]
  expiry: bigint
}
export interface Seat {
  index: number
  role: string
  worker: Address
  agentId: bigint
  reward: bigint
  bond: bigint
  deadline: bigint
  judgeSeat: number
  dependsOn: number[]
  required: boolean
}
export interface Roster {
  jobId: Hex
  creator: Address
  shapeHash: Hex
  swarmId: bigint
  arbitrator: Address
  activateBy: bigint
  seats: Seat[]
}
export interface Reassign {
  jobId: Hex
  seat: number
  worker: Address
  agentId: bigint
  deadline: bigint
}
export interface Submission {
  jobId: Hex
  seat: number
  deliverableHash: Hex
  transcriptRoot: Hex
}
export interface Ruling {
  jobId: Hex
  seat: number
  workerWins: boolean
  transcriptRoot: Hex
}

type Primary = 'Quote' | 'Roster' | 'Reassign' | 'Submission' | 'Ruling'

export function sign<T extends object>(account: PrivateKeyAccount, primaryType: Primary, message: T) {
  // viem's typed-data generics cannot follow a runtime primaryType; the shapes above are the contract.
  return account.signTypedData({ domain, types, primaryType, message } as never)
}

export function signer<T extends object>(primaryType: Primary, message: T, signature: Hex) {
  return recoverTypedDataAddress({ domain, types, primaryType, message, signature } as never)
}
