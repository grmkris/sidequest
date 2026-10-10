export const COMMONS_OBJECT_NAME = '__sidequest_commons_v1__'
export const commonsReadTools: ReadonlySet<string> = new Set([
  'list_messages',
  'list_gaps',
  'list_roadmap',
  'get_roadmap_item',
  'list_roles',
])
export const commonsWriteTools: ReadonlySet<string> = new Set([
  'post_message',
  'report_gap',
  'propose_item',
  'support_item',
  'withdraw_support',
])
export const commonsRoleTools: ReadonlySet<string> = new Set([
  'hide_content',
  'unhide_content',
  'set_item_status',
  'merge_items',
  'merge_gaps',
  'link_gaps',
  'set_gap_status',
])
export const commonsToolNames: ReadonlySet<string> = new Set([
  ...commonsReadTools,
  ...commonsWriteTools,
  ...commonsRoleTools,
])
