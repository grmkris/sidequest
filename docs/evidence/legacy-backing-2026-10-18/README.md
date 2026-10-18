# Legacy backing route

Implemented locally; no deploy or live transaction verification.

- `/backing` replaces its history entry with `/account?tab=backing`.
- Historical source (`2aeeff74^:apps/explore/src/routes/Backing.tsx`, also `2d257c7a`) accepted `?account=<wallet>`. A valid, nonzero address now leads to `/wallet/<address>`; that existing resolver opens the agent profile when known, or the wallet profile otherwise. It does not assume the visitor owns the agent or open a transaction.
- No historical agent-ID, `next` or external redirect form was found. Unsupported, invalid, duplicate and zero `account` context falls back to Account. Current Explore source has no remaining links to the retired route; tests include a synthetic legacy entry.
- Automatic onboarding respects the explicit Backing destination. Sign-in remains in place on Account. Existing profile and Account backing controls are unchanged.

## Validation

Clean baseline at `fac2ada037cdc0163a53955c65dd9b498dd133fc`: `env -i HOME=/tmp/sq-run PATH="$PATH" bun run --cwd apps/explore test` — 126 files / 621 passed / 0 skipped. Chromium was installed in this clean HOME before the successful run. Initial run without it: 125 files passed, 614 tests passed, 7 skipped, one suite failed setup.

Measured after rebase on `c98472be8a34a0bc01fec8a8df522ac9ff6e5386`: 127 files / 628 passed / 0 skipped (pre-rebase: 127 / 626 / 0). `src/backing-route.test.ts` exercises the production compatibility route with TanStack memory history, reload reconstruction, back/forward replacement and the in-place sign-in/onboarding boundary. All three tests fail with the route omitted. The onboarding guard assertion also failed before its fix.

`browser.jsonl`, [desktop](1280.webp) and [390px](390.webp) record local Chromium navigation through the real app, replacement, reload/back/forward and no horizontal overflow. Privy is unconfigured locally: real authenticated sign-in and wallet interactions were unavailable; the sign-in boundary is covered with simulated auth facts, not a live login. No mainnet RPC variable or wallet transaction was used for tests.

Repository checks and the final measured counts are recorded in the pull request.
