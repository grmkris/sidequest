/**
 * Hosted agents' public identity: avatars from R2 (`/avatars/<sha>.<ext>`), ERC-8004 registration files
 * (`/profiles/<agent key>.json`, what a hosted agent's agentURI names) and `/data/profiles[/<agentId>]`. Profiles live
 * in the management object, which `read` reaches; nothing here needs a session.
 */
import { avatarResponse, type AvatarBucket } from '../avatars.ts'
import { profilesResponse, registrationResponse, type HostedProfile, type ProfilesReader } from '../profiles.ts'

export const isProfilePath = (path: string) =>
  path.startsWith('/avatars/') ||
  path.startsWith('/samples/') ||
  path.startsWith('/profiles/') ||
  path === '/data/profiles' ||
  path.startsWith('/data/profiles/')

export interface ProfileRouteDeps {
  bucket: AvatarBucket | undefined
  /** The management object's `managedProfiles`: one registration by key, or the minted profiles (one by Agent ID). */
  read: (req: { agentKey?: string; agentId?: string }) => Promise<string>
}

export async function profileRoute(path: string, origin: string, deps: ProfileRouteDeps) {
  if (path.startsWith('/avatars/')) return avatarResponse(deps.bucket, path)
  if (path.startsWith('/samples/')) return avatarResponse(deps.bucket, path, 'samples')
  const reader: ProfilesReader = {
    registration: async (agentKey): Promise<HostedProfile | null> => JSON.parse(await deps.read({ agentKey })),
    profiles: async (agentId): Promise<HostedProfile[]> =>
      JSON.parse(await deps.read(agentId === undefined ? {} : { agentId })),
  }
  return path.startsWith('/profiles/')
    ? registrationResponse(reader, origin, path)
    : profilesResponse(reader, origin, path)
}
