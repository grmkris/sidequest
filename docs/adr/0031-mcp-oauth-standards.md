# 0031: Standards-first MCP OAuth

Status: accepted (Kris, 25 Oct 2026)
Date: 2026-10-25

Sidequest follows MCP Authorization revision 2026-07-28 and OAuth 2.1 security requirements. Client ID Metadata
Documents are the primary registration mechanism on dev and prod for the supported public clients; dynamic registration
remains only as a deprecated fallback while clients finish their migration. Metadata is fetched in the Worker with a
5-second deadline, no redirects, a 5 KiB body cap, JSON validation, public-fetch routing and an explicit client trust
policy. The fetched document's `client_id`, callback URIs and public authentication method are checked before it is
stored in the OAuth Durable Object.

The trust list is the exact metadata URLs `https://claude.ai/oauth/mcp-oauth-client-metadata`,
`https://chatgpt.com/oauth/client.json`, `https://chatgpt.com/oauth/codex/client.json`, and
`https://vscode.dev/oauth/client-metadata.json`. The cache honors `no-store`, `no-cache`, and `max-age` minus `Age`,
capped at one hour. This release supports only public clients (`token_endpoint_auth_method` absent or `none`);
documents requiring `private_key_jwt`, including ChatGPT's currently published document, are rejected. Per-client
signed-in acceptance remains necessary before dynamic registration can be removed.

Only HTTPS and loopback HTTP callback URIs are accepted. Loopback IP literals may vary only by port; path, query and
fragment remain bound. Custom schemes, including `cursor://`, are refused. The consent page displays the callback host
and warns when the callback uses HTTP loopback.

The MCP challenge and protected-resource metadata expose only Sidequest's MCP scopes. The authorization server accepts
an optional `offline_access` request for clients that still send it, but refresh tokens are issued by the authorization
server rule without requiring that scope. DPoP is not advertised or accepted: the resource uses audience-bound Bearer
tokens. DPoP may be added only as a complete implementation with proof checks at every resource server after the MCP
extension is stable.

HTTPS redirect and HSTS for the Sidequest zone are enforced at Cloudflare's edge. The Worker pins OAuth issuer,
resource and consent URLs to `PUBLIC_ORIGIN` and redirects alternate hosts to that canonical origin. Cloudflare's
Always Use HTTPS setting redirects plain HTTP before the request reaches the Worker.
