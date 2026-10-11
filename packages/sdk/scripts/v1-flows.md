# Sidequest v1 live matrix

`bun run testnet:v1:flows --list` lists the implemented cases without keys or RPC calls.
`bun run testnet:v1:flows hire,cancel,topup-paid` runs the short money paths. Pass a comma-separated list;
`all` includes long waits and integration prerequisites. Only chain 10143 is accepted, and the SDK must load
a promoted v1 `main` pair. The runner never deploys or edits the deployment config.

Run from the backend worktree with the selected stage environment. Set the plain names in the process environment, or
pass `--stage dev`/`--stage prod` to load `~/.config/sidequest/<stage>.env`. Required names:
`MONAD_RPC_URL`, `TESTNET_CREATOR_PRIVATE_KEY`, `TESTNET_WORKER_PRIVATE_KEY`, `RELAY_PRIVATE_KEY`,
`V1_ARBITRATOR_PRIVATE_KEY`. Its address is checked against `sidequest.defaultArbitrator`. The named arbitrator is
passed explicitly at publish; the worker checks the listing and signs a fresh net quote before activation.

Optional `TESTNET_AGENT_ID` reuses a registered worker identity. Otherwise registration is journaled.
`V1_FLOW_REWARD` (default 1 token), `V1_FLOW_BOND` (default 10 SIDE), and `V1_STAKE_TARGET` (default
100 SIDE) are whole-token decimal amounts. Decimals are read on chain. Fund these wallets with testnet
MON, SIDE v2 and the configured reward token before running.

The three delegated cases reuse the creator as an outside owner and, for `slash-pro-rata`, the relay as
another outside owner. The creator journals the relay's SIDE funding; no extra keys are needed. Start with
no open worker bonds, no queued worker shares, and no existing creator/relay positions in that worker pool.
`delegate` needs enough liquid creator SIDE to reach the worker's next fee tier and reserves more than
the worker's own position can cover. Each case exits its outside positions after the deployed cooldown,
so the following `fees` case still begins below the second tier. `undelegate-pending-slash` keeps a second
job active across the first ruling, checks `UndelegateLocked` on both sides of the slash, then releases that bond
and verifies the actual post-slash withdrawal event and token transfer after cooldown. Both jobs' expiries fit
within the deployed unstake horizon; submission, dispute and settlement happen before that wait.

Every signed transaction, including setup/approvals, is saved before broadcast in
`packages/sdk/scripts/.v1-flows/<V1_FLOW_PROFILE>/journal.json` (profile defaults to `default`). It contains signed authority, so it is ignored by git and
written with mode 600. Preserve it for retries. A retry reconciles the exact hash and raw transaction;
an independently consumed nonce refuses another send. Changing deployment, wallets or reward/bond amounts
requires a separate profile/journal. A process lock prevents concurrent use of one journal; a stale lock is
reclaimed only when its recorded process no longer exists. Restart a stale journal from one process only;
stale-lock reclamation is not atomic between simultaneous restarts. Do not reuse the same wallets across two profiles. Flows run sequentially,
so the runner remains below the two-flow and 15-rps limits.

New core and hosted offers use the Holding's deployed minimum review/dispute/arbitration windows. Clock waits
resume from the job's frozen terms, the vault's `unlockAt`, or the proposal's on-chain ETA. Testnet constructor
clocks are configurable; the fresh testnet cooldown is three days and production uses fourteen days. The production
12-hour arbitration minimum is not a runner constant. An existing
journal keeps its original terms and signed bytes through a code update; a redeployment requires a new profile.

| Live matrix row                                          | Case(s)                                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hire, silence, cancellation                              | `hire`, `silence`, `cancel`                                                                                                                               |
| Both ruling directions and slash flags                   | `ruling-worker`, `ruling-worker-slash`, `ruling-creator`, `ruling-creator-slash`                                                                          |
| Undisputed violation and missed delivery                 | `violation`, `missed`                                                                                                                                     |
| Arbitration timeout                                      | `arbitration-timeout` (deployed per-job window)                                                                                                           |
| Top-up payment and contributor pull refund               | `topup-paid`, `topup-refund`                                                                                                                              |
| Delegated backing, reservations, slash, cooldown         | Setup delegates with `delegate`; the hire/slash cases; `delegate`, `slash-pro-rata`, `undelegate-pending-slash`, and `stake-cooldown` (vault unlock time) |
| Owned delegated backing and snapshotted fee tier         | `delegate`                                                                                                                                                |
| Two outside owners plus self stake, ruled pro-rata burn  | `slash-pro-rata`                                                                                                                                          |
| Slash queued shares, retain a second bond, then withdraw | `undelegate-pending-slash`                                                                                                                                |
| Two fee tiers                                            | `fees` (worker must begin below tier 2 and have enough liquid SIDE to reach it)                                                                           |
| Real refusing tokens → owed → withdrawal                 | `owed-blocklist`, `owed-gas`                                                                                                                              |
| Direct hire with sponsored activation/decisions          | `direct-hire`                                                                                                                                             |
| Request → quote → hire                                   | `quotes`                                                                                                                                                  |
| Execution budget with worker bond                        | `budget-advance`, `budget-call`                                                                                                                           |
| Sponsorship rate/call cap refuses                        | `sponsor-caps` (at most 20 harmless calls before the hourly rate refuses)                                                                                 |
| Canonical cross-board Collect                            | `collect` (requires a real pending claim/settlement, refuses an empty result)                                                                             |
| Telegram notifications                                   | `telegram` (linked creator/worker; produces a real hire; human DM/channel receipt is recorded separately)                                                 |
| Safe ownership, fee delay, vault delay, pause            | `admin-ownership`, `admin-fees`, `admin-vault-refusal`, `admin-pause`                                                                                     |

The G1c candidate adds `delegate`, `slash-pro-rata` and `undelegate-pending-slash`,
bringing the default board-free rehearsal to 23 v1 cases. Use `--list` to
confirm the runner candidate is adopted before starting them. Outside delegators
retain their positions; a slash reduces self and outside positions pro-rata,
including queued shares. The pending-slash case proves cooldown refusal while bonds remain open and
then withdrawal of the post-slash value after release and unlock. These cases and local fork
results are not live G1c evidence.

Hosted cases require `V1_BOARD_URL` pointing to this testnet deployment. Each wallet signs in with SIWE.
The runner checks `protocol_info` before hosted writes and reports each canonical receipt. Sponsor action keys
are persisted and reused after a lost response; the relay's hash is printed and polled. `create_task`,
`request_quotes` and `pick_quote` each use a stable `idempotencyKey` derived from the journal's persisted run key.
Those keys recover the same server preparation after a lost response, scoped to the caller, tool and board.
A quote retry reads its existing quote before creating one. Budget call exercises
a real ERC-20 transfer from the creator's DeleGator, with one allowed function and bounded value.

Odd-token cases require the coordinator's promoted `deployment.oddTokens` and `TESTNET_ODD_OWNER_PRIVATE_KEY`.
They arm the real token after submission, verify deferred payment, settled bonds and exact `owed`, clear the
refusal and withdraw. A crash while armed resumes those same steps; do not abandon the journal. Successful
receipts and intermediate assertions are saved before later steps; final readbacks run again after interruption,
including after the final withdrawal/cancellation/unpause receipt. Saved unmined bytes are never completion.

Admin cases require `SAFE_BACKUP_TESTNET_PRIVATE_KEY`, an owner of the threshold-1 configured testnet Safe.
G1 prepares fee and Holding proposals. `admin-vault-refusal` proves early refusal and cancels the existing probe.
Run `admin-fees` next: it consumes the unchanged launch schedule after the deployed fee delay, within its proposal grace,
before job windows and delegated cooldowns can expire it. `admin-pause` uses atomic Safe
MultiSendCallOnly pause/notePause and unpause/notePause pairs (the Safe needs the core admin role).

Long cases print their chain-time wait and resume from the saved journal after interruption. Start the
12-hour arbitration row in time for G3; start the vault cooldown immediately after G1
(fresh testnet clocks use three days; production uses fourteen days; retained deployments keep their immutable delay).
A queued position remains slashable until withdrawal and may be delayed by
`StillBonded` while a bond is reserved. Use at most two
isolated wallet sets when running long cases in parallel. Mining waits for B8/B8b and a published/funded root;
Telegram waits for the real bot and wallet links. Missing dependencies error rather than count as evidence.
Set `V1_FLOW_YIELD=1` when starting several long cases together: each case journals its pending chain timestamp,
releases the runner after its prerequisite sends, and resumes on the same journal once that timestamp is reached.

The runner prints every signed hash before broadcast and after receipt. Local fork tests run the same journal,
core lifecycle and hosted registry code with real bytecode. Those tests establish local integration only;
the coordinator records remote hashes and actual Telegram delivery in `docs/reality-check.md` at G1/G2/G4.
