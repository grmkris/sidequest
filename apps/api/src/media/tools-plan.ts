/** The post plan's and the shares' tools (ADR-0029). */
import { BoardError } from '@sidequest/board'
import * as Args from './args.ts'
import * as store from './store.ts'
import { actorName, requireRole } from './access.ts'
import { linker, type MediaDeps, type MediaTool, mediaTool, randomId, writeContext } from './tool-kit.ts'
import { shareHash, shareToken } from './tokens.ts'

type Actor = Parameters<MediaTool['run']>[1]

async function share(
  deps: MediaDeps,
  actor: Actor,
  input: (typeof Args.ShareMedia)['Type'],
  args: Record<string, unknown>,
) {
  requireRole(actor, 'member')
  const ctx = writeContext(deps, actor, 'share_media', args)
  const ofCampaign =
    input.campaign === undefined
      ? []
      : (await store.listMedia(deps.sql, actor, { campaign: input.campaign }, () => Promise.resolve(null))).assets.map(
          (asset) => asset.id,
        )
  const assets = [...new Set([...(input.assets ?? []), ...ofCampaign])]
  if (assets.length === 0 || assets.length > 50) throw new BoardError('invalid', 'share 1–50 assets')
  const token = await shareToken(deps.signingKey, actorName(actor), ctx.operationKey)
  const result = await store.createShare(deps.sql, ctx, {
    id: randomId('sh_'),
    hash: await shareHash(token),
    assets,
    ...(input.label === undefined ? {} : { label: input.label }),
    expires: deps.now() + (input.days ?? 30) * 86_400,
  })
  return { ...result, url: `${deps.origin}/media/s/${token}` }
}

async function openShare(deps: MediaDeps, input: (typeof Args.GetShare)['Type']) {
  const found = await store.liveShare(deps.sql, await shareHash(input.token), deps.now())
  if (found === undefined) throw new BoardError('not-found', 'this share link has expired or does not exist')
  return {
    ...(found.label === null ? {} : { label: found.label }),
    expiresAt: found.expiresAt,
    assets: await store.sharedAssets(deps.sql, found.assets, linker(deps, { kind: 'public' }, input.token)),
  }
}

export const planTools: Record<string, MediaTool> = {
  list_media_posts: mediaTool(
    "Sidequest's social posts. Anyone sees what went out (with the post URL); the media team sees the whole plan: drafts, approved and skipped posts, by day.",
    Args.ListPosts,
    (deps, actor, input) => store.listPosts(deps.sql, actor, input),
  ),
  save_media_post: mediaTool(
    'Plan a social post (channel, account, day, time, text, files), edit one, skip one, or approve one (a media operator). Approving needs every file public; publishAssets publishes them in the same step. Editing what an approved post says or shows returns it to draft. Posting itself is done by hand or with a browser; then call record_media_post.',
    Args.SavePost,
    (deps, actor, input, args) => {
      const { id, revision, status, publishAssets, ...fields } = input
      return store.savePost(deps.sql, writeContext(deps, actor, 'save_media_post', args), {
        id: id ?? randomId('p_'),
        fields,
        ...(revision === undefined ? {} : { revision }),
        ...(status === undefined ? {} : { status }),
        ...(publishAssets === undefined ? {} : { publishAssets }),
      })
    },
  ),
  record_media_post: mediaTool(
    "Record a post that went out, by its public URL: a planned post once approved (id; any team member), or one made outside the plan (a media operator; channel from the URL; name the assets it used). Changing the link of a post that is out is an operator's. One record per post URL; tracking parameters are dropped. Recording never publishes a file.",
    Args.RecordPost,
    (deps, actor, input, args) => {
      const { id, url, postedAt, ...fields } = input
      return store.recordPost(deps.sql, writeContext(deps, actor, 'record_media_post', args), {
        id: id ?? randomId('p_'),
        url,
        postedAt: postedAt ?? deps.now(),
        planned: id !== undefined,
        fields,
      })
    },
  ),
  list_media_shares: mediaTool(
    'The media team: every share link made, live or not (never their tokens).',
    Args.Nothing,
    (deps, actor) => store.listShares(deps.sql, actor, deps.now()),
  ),
  get_media_share: mediaTool(
    'What a share link holds: its label, expiry and assets with download URLs. Anyone with the link.',
    Args.GetShare,
    (deps, _actor, input) => openShare(deps, input),
  ),
  share_media: mediaTool(
    'The media team: a link that lets someone outside the team download internal assets without signing in, until it expires (default 30 days, at most 90) or is revoked. Name assets, or a campaign for all of its assets. The link is in the reply; keep it out of public places.',
    Args.ShareMedia,
    share,
  ),
  revoke_media_share: mediaTool(
    'The media team: stop a share link at once.',
    Args.RevokeShare,
    (deps, actor, input, args) =>
      store.revokeShare(deps.sql, writeContext(deps, actor, 'revoke_media_share', args), { id: input.id }),
  ),
}
