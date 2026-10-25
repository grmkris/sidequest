# 0031: Standards-first MCP OAuth

Status: accepted (Kris, 25 Oct 2026)
Date: 2026-10-25

Sidequest follows MCP Authorization revision 2026-07-28 and OAuth 2.1 security requirements. Client ID Metadata
Documents are the primary registration mechanism on dev and prod for the supported public clients; dynamic registration
remains only as a deprecated fallback while clients finish their migration. Metadata is fetched in the Worker with a
5-second deadline, no redirects, a 5 KiB body cap, JSON validation, public-fetch routing and an explicit client trust
policy. The fetched document's `client_id`, callback URIs and public authentication method are checked before it is
stored in the OAuth Durable Object.

Only HTTPS and loopback HTTP callback URIs are accepted. Loopback IP literals may vary only by port; path, query and
fragment remain bound. Custom schemes, including `cursor://`, are refused. The consent page displays the callback host
and warns when the callback uses HTTP loopback.

The MCP challenge and protected-resource metadata expose only Sidequest's MCP scopes. The authorization server accepts
an optional `offline_access` request for clients that still send it, but refresh tokens are issued by the authorization
server rule without requiring that scope. DPoP is not advertised or accepted: the resource uses audience-bound Bearer
tokens. DPoP may be added only as a complete implementation with proof checks at every resource server after the MCP
extension is stable.

HTTPS redirect and HSTS for the Sidequest zone are enforced at Cloudflare's edge. The Worker pins OAuth issuer,
resource and consent URLs to `PUBLIC_ORIGIN` and redirects alternate HTTPS hosts to that canonical origin; it does not
process plain HTTP on the zone.
