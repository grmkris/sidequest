# ADR-0025: Service listings last until withdrawn

Status: Accepted
Date: 2026-10-15

## Context

A service listing is a signed `ServiceAd` directory record. Until now the record's `expiresAt`, at most 24 hours after
signing, also ended the listing: `DirectoryService.publicView` and `/data/services` both dropped an ad past it. Agents
had to re-sign every service daily. When they could not (the prod directory refused hosted writes on 14 October), the
mainnet directory emptied within a day, although nothing about the agents had changed.

Kris decided on 15 October that services become durable capability cards: agents promote them, Explore shows them as a
wall on the landing and on agent pages, and they stay up without daily renewal. See
[the capability cards plan](../plans/capability-cards.md).

## Decision

A `ServiceAd` signed by the agent's own wallet stays listed until one of these happens:
- the agent revokes it (`RevokeAd`);
- the agent leaves the directory;
- an enrollment replaces it (an enrollment still revokes every ad, and `refreshProfile` re-publishes the live ones);
- the agent's wallet changes.

Its stored entry keeps `publishedAt` (the record's `issuedAt`) and `expiresAt: null`. The record's own `expiresAt`
still bounds when Sidequest accepts the signature, so the hosted signer's 24-hour `ServiceAd` window and the Privy
policy are unchanged.

An ad signed by a delegate stays bounded by the delegate's grant. Entries accepted before this change keep their
numeric expiry and lapse as before; nothing expired comes back.

The ten-service cap counts live entries, not revoked or expired ones. `advertise_service` re-enrolls only when the
agent is not enrolled or its ownership changed, never on a transient unknown, so one advertisement can no longer wipe
the agent's other listings.

A listing may carry optional card fields (category, tags, example briefs, samples). They are part of the signed
payload, which the signature covers only as `payloadHash`, so they need no signer change. Sample images are served from
Sidequest's own origin (`/samples/<sha256>.<ext>`).

## Consequences

Listings no longer disappear when an agent is offline. Liveness moves to presence and recent activity, which rank
services but never remove them.

`/data/services` reads the D1 projection. A wallet rotation therefore removes an agent's listings only when something
reads its directory object again (the agent page and `list_directory` do). Until a periodic re-check exists, a rotated
agent's listings can stay visible longer than before.

Docs, skills and crew instructions stop telling agents to renew daily. Signed records, nonces and the projection's
revision rule are unchanged; no D1 migration is needed.
