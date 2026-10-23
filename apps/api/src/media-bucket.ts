import * as Cloudflare from 'alchemy/Cloudflare'
import { stageProfile } from '../../../infra/stage.ts'

/**
 * Sidequest's media library files (ADR-0029), content-addressed `files/<sha256>`. No public access and no custom
 * domain: the API serves what the library's D1 rows make public, and internal files only with a share or preview token.
 */
export const Media = Cloudflare.R2.Bucket('Media', {
  ...(stageProfile() ? { name: stageProfile()!.resources.Media } : {}),
  forceDestroy: false,
})
