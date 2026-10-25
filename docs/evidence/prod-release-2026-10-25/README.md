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
