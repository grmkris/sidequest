import { Schema } from 'effect'

/** Hosted issuer identity comes from the deployment, not a caller-controlled request host. */
export function oauthOrigin(requestOrigin: string, configured: unknown): string {
  const canonical = new URL(Schema.decodeUnknownSync(Schema.String)(configured))
  return canonical.protocol === 'https:' ? canonical.origin : requestOrigin
}

/** Alternate hosted names converge on the issuer. HTTPS on our zone is enforced at the Cloudflare edge. */
export function oauthHostRedirect(requestUrl: URL, configured: string): string | undefined {
  const canonical = new URL(configured)
  if (canonical.protocol !== 'https:' || requestUrl.host === canonical.host) return undefined
  const target = new URL(requestUrl)
  target.protocol = canonical.protocol
  target.host = canonical.host
  return target.href
}
