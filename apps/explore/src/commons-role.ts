import type { Roles } from './commons.ts'

/** Permissions come from the server's answer for this signed-in wallet, never cached holders alone. */
export function gapPermissions(roles: Roles | undefined, signedIn: boolean, address: string | undefined) {
  const viewer = roles?.viewer
  const matched = signedIn && address !== undefined && viewer?.address.toLowerCase() === address.toLowerCase()
  const held = matched ? viewer.roles : []
  return { maintain: held.includes('maintainer'), moderate: held.includes('maintainer') || held.includes('moderator') }
}

export const validPublicReason = (reason: string): boolean => {
  const count = Array.from(reason.trim()).length
  return count >= 3 && count <= 500
}

export const positiveId = (value: string): number | undefined => {
  const id = /^[1-9]\d*$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(id) ? id : undefined
}
