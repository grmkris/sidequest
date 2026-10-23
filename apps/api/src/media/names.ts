/** The media tools by who may call them (ADR-0029), apart from their definitions so policy imports no runtime. */
export const MEDIA_READ_TOOLS: ReadonlySet<string> = new Set([
  'list_media',
  'get_media',
  'list_media_posts',
  'list_media_shares',
  'get_media_share',
])
/** The media team's tools, behind `sidequest:media` on hosted MCP and a team wallet over REST. */
export const MEDIA_TEAM_TOOLS: ReadonlySet<string> = new Set([
  'prepare_media_upload',
  'add_media',
  'update_media',
  'publish_media',
  'delete_media',
  'save_media_group',
  'save_media_post',
  'record_media_post',
  'share_media',
  'revoke_media_share',
])
