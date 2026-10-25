# Production release, 25 October 2026

Kris approved in the 2026-10-25 overnight plan.

The approved runtime range is `7f05c9fed293f668cb80f70dc2d4bfb79a8c3a8a..28e4615e1b444c47720eb481eb050b4921e64f92`.
It includes the pending Commons fixes, Chromium cache fixtures and the user-facing em dash rule. The rule keeps one
named marker for empty cells and adds the instruction against speculative complexity without the user's buy-in.

The local full gate and build passed. [Dev CI](https://github.com/grmkris/sidequest/actions/runs/40152874145) passed
verify, deploy-dev, smoke and drift. A separate local `bun run smoke dev` passed. Local drift was refused before planning
because the local stage file lacks `PIMLICO_API_KEY` and `TESTNET_PAYMASTER_SIGNER_KEY`; the CI Drift dev step passed
with its protected stage credentials. No credential was copied or changed.

The range has no `apps/arbiter/**` change. The changed `crew/shared/COMMON.md` is read by the crew runner, not the
arbiter/moderator role containers. No role restart or mainnet transaction is part of this release.

Promotion passed under the overnight repository lock. [Production CI](https://github.com/grmkris/sidequest/actions/runs/40153851571)
passed verify, deploy-prod, smoke and drift. A separate local `bun run smoke prod` passed against
`https://sidequest.exchange`; `acceptance.json` retains the status-only receipt. Public smoke establishes health/discovery and anonymous refusals,
not authenticated hiring, paid-provider acceptance or a mainnet transaction.


## OAuth conformance promotion

Kris approved in the 2026-10-25 overnight plan. Kris approved in the 25 Oct session.

The OAuth runtime source at `f7848821` was accepted on dev release `1a562ae727897a02f0ee82b9aed8bd1579825073`, with [green CI](https://github.com/grmkris/sidequest/actions/runs/40192403249), smoke/drift and [committed OAuth evidence](../mcp-oauth-2026-10-25/README.md). Fresh-context auth review has no unresolved blocker. Promotion carries the OAuth fixes and intervening tooling/docs commits.

The only `apps/arbiter/**` change since current prod `25de7f49` is its `typecheck` script. The role runtime and dependencies are unchanged; under `docs/deploy.md`'s runtime restart rule the signing arbiter is not restarted for a checker change. No mainnet transaction is authorized or performed by this release. The production CI link and live readback will be recorded in the worker receipt after promotion.
