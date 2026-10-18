# Post a job agent handoff evidence

The local Chromium harness covers the real `JobsHeader` and `CreateWithAgent` components at 1280px and 390px. It exercises signed-out sign-in, no-agent setup, one and multiple verified publishers, Work-only/unknown/revoked agents, failed and retried publisher reads, tenant-scoped MCP resources, brief persistence, keyboard interaction, copy state, close state, and confirms no API write occurs.

`1280.png` and `390.png` are captured by `test/hiring-handoff.test.ts`. The harness uses a local auth/API fixture because this container has no configured Privy session; no production credentials or wallet calls are used.

Rebased on `c98472be8a34a0bc01fec8a8df522ac9ff6e5386`: clean Explore run passed 128 files / 632 tests / 0 skipped. The first simultaneous verification run timed out in three browser cases; rerunning the suite alone passed without changing code or timeouts. Initial baseline: 126 / 621 / 0; pre-rebase final: 128 / 630 / 0; the rebased clean run passed 128 / 632 / 0.
