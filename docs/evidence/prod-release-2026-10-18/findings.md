# dev → prod release, 18 Oct 2026: review findings

Range: prod `8fdbcb06` → dev `535db089` (25 commits). Kris, 18 Oct 01:20: review, fix every finding, promote
to prod, live-test, report on Telegram. Fix worktree: `agent-jobs.wt/release-1018` (branch
`release-1018-fixes`, fast-forwarded onto dev).

| # | Sev | Area | Finding | Verified | Fix | Status |
|---|---|---|---|---|---|---|
| E1 | Medium | ops | `sq-moderator-mainnet` runs e971ce93, before presentations, so attachments go unmoderated on mainnet. The dev moderator and maintainer also run the old `roles` tree | yes (docker inspect + merge-base) | After the prod deploy: `roles.ts up <sha> moderator` (prod) and `moderator maintainer` (dev); add the step to the runbook | doc `56fbcaeb`; rollout after the deploy |
| E2 | Low | docs | `app.mdx:55` says exits and sweeps use the "relay", but mainnet has no relay; `:27` says test tokens have no value without the testnet qualifier | yes | Reword, then run `gen-docs` | fixed `9adb10aa` |
| E3 | Low | docs | The spike README in the public repo named internal paths and commits from private partner repositories | yes | Generalise the references | fixed `38cdbf6b` |
| A1 | Medium | sdk | OpenUI references re-expand inside the 4096-step cap: a 31 KB source becomes ~62 MB of JSON before `assertSize` rejects it, inside the single Commons DO and before posting-access checks (reviewer RSS 64→196 MB) | yes (code + repro `/tmp/claude-review/amp.ts`) | Byte budget on evaluated strings and keys in `normalizeOpenUI` | fixed `5a24098a` (62 MB → 32 KB peak, 7 ms) |
| A2 | Low | ops | Posts made between the API deploy and the moderator re-pin are skipped by the old moderator's cursor | = E1 | The new moderator reads `presentation` as optional, so start it on the release SHA BEFORE the prod push: no gap | planned: pre-push |
| A3 | Low | sdk | The `post_message`/`list_messages` JSON Schemas use a nested `$schema`, `\p{Cc}` patterns, `propertyNames` and `format: starts_with`, which fail strict Ajv | repro `/tmp/claude-review/ajv.ts` | Plain, portable schema output | fixed `a1f306ab` (default Ajv 0 failures, Python re OK, 0 BMP mismatches) |
| A4 | Low | commons | Thread reads parse each presentation twice (row + output filter), about 90 ms of CPU for a full page of 32 KiB attachments | measured | Skip the second full parse | fixed `b42bb45f` (WeakSet of validated docs) |
| C1 | Medium | explore | "Sign in and post" unmounts Composer mid-post, the draft survives, and a second click double-posts | repro run-signin.mjs | Snapshot acknowledgement from ThreadView; keep Composer mounted | fixed `159e4f75` (Codex, Chromium before/after) |
| C2 | Low | explore | A choice added mid-post is wiped on success | repro | Snapshot acknowledgement | fixed `c4670351` (Codex, Chromium before/after) |
| C3 | Low | explore | A failed lazy plan-editor chunk crashes the page and loses the draft | repro | Error boundary | fixed `0d76243f` (Codex, Chromium before/after) |
| C4 | Low | explore | Plan reply buttons are active for viewers who cannot post | repro | Pass onDraft only when the form renders | fixed `184164e3` (Codex, Chromium before/after) |
| C5 | Low | explore | A draft carries over to another thread | repro (harness) | Key or reset by subject | fixed `22e71a9e` (Codex, Chromium before/after) |
| R1 | Low | explore | Markdown link text can show a different URL; the external-link confirmation was dropped | repro | Show the off-site hostname, new tab | fixed `c7478ec8` (Codex, Chromium before/after) |
| R2 | Low | app/react + sdk | Another poster's text is sent to the AI conversation as the user's own; unlimited newlines can hide a payload | code | Quote with source (Codex) + collapse newline runs in the catalog (me) | fixed `999e5aca` (catalog) + `ada82924` (attributed quote) |
| R3 | Low | explore | Streamdown + Presentation (~199 KB gzipped) load on every page | measured live | Lazy-load with a plain-text fallback | fixed `ab8d18e8` (Codex, Chromium before/after) |
| R4 | Low | app | The MCP App never reports its height (autoResize off) | repro | `autoResize: true`, regenerate | fixed `31377087` (Codex, Chromium before/after) |
| R-n | nit | explore | Footnote ids dropped, sr-only heading visible, multi-line raw HTML collapses | repro | Keep ids/classes/line breaks | fixed `e7a0b2dd` (Codex, Chromium before/after) |
| R-d | accepted | explore | The Mermaid input filter rejects some ordinary diagrams | — | None: safe by design, a feature limitation | accepted |
| D1 | Low | deps | The patched decode-uri-component is still superlinear on many distinct malformed runs: upstream 0.5.0 behaviour, browser-only (WalletConnect query-string) | yes | None this release; drop the patch once the wallet tree moves to 0.5.x | accepted |
| D2 | Low | api | `getReader()` sits outside the try, so a locked body would 500 instead of 400 (not reachable today) | code | Move inside the try | fixed `0ff7032b` |
| L1 | Low | explore | Live test found that e7a0b2dd's container-wide `pre-line` rendered 27 inter-block newline nodes as blank lines (43 px gaps) in every formatted prod post | yes (live DOM on prod) | Drop newline-only text beside blocks (rehype step) | fixed `e00ebfed`, second promotion |
