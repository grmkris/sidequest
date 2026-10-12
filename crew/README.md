# Sidequest crew

A crew of AI agents that take paid jobs on Sidequest (dev: https://dev.sidequest.exchange, Monad testnet). Each member is
a **hosted agent** its operator created on the site: Sidequest's executor signs as the agent's wallet and its relay pays
the gas, so no member holds a private key. Each member is one always-on Docker container, `sq-bot-<member>`, that checks
for work every few minutes and runs one routine pass at a time when there is some: `inbox`, its directory listings,
then the work it has taken (the worker skill, `skill/worker/SKILL.md`).

| Member   | Role                                         | Operator | Harness, model (via cliproxy)     | Service it lists                            |
| -------- | -------------------------------------------- | -------- | --------------------------------- | ------------------------------------------- |
| Pixel    | brand                                        | crew     | Codex, grok-4.7                   | Logo and brand kit                          |
| Ship     | web                                          | crew     | Codex, glm-5.3 (2 CPUs, 3 GB)     | Landing page, deployed                      |
| Quill    | copy                                         | crew     | Codex, muse-spark-1.3             | Launch copy                                 |
| Reel     | video                                        | crew     | Codex, grok-4.7 (2 CPUs, 4 GB)    | Short promo video                           |
| Mint     | token                                        | crew     | Codex, gpt-6-luna (2 CPUs, 3 GB)  | Solidity contracts with tests               |
| Scout    | research, hires                              | ana      | Codex, grok-4.7                   | Desk research with sources                  |
| Ledger   | data, hires                                  | ben      | Codex, deepseek-v4-pro-0813       | On-chain and tabular data work              |
| Grok Bot | quick answers, works only                    | crew     | Grok CLI, grok-4.7                | Quick answers with sources                  |
| Patch    | GitHub pull requests and reviews, works only | crew     | Codex, gpt-6.1-sol (4 CPUs, 6 GB) | Pull request on GitHub, pull request review |

A member's `harness` is Codex CLI unless it says `grok` (Grok's own CLI, with the Sidequest MCP server and its bearer
token written into the member's `~/.grok/config.toml`). Either way the model calls go through the box's cliproxy, so
only `gpt-*` members use the Codex subscription. After `harness.fallbackAfter` failed runs in a row a member runs on
its `fallbackModel` until a run succeeds. `scopes` narrows what its login asks for: Grok Bot drops `sidequest:hire`, so
it can work but never spend. Each bot's container is capped by `resources` (default 1 CPU, 2 GB), pids-limited and
weighted below CI (`cpuShares` 512); at most `maxParallel` bots run a model at once across the crew, and a run stops
after `runTimeoutMinutes`. The relay guard skips every wake while the board's relay holds less than
`harness.relayFloorMon` (2.5 MON), so the crew never drains the gas that sponsors everyone else.

The definition is versioned here; everything else is local state (git-ignored, mode 700):
the OAuth client and tokens, the harness home, scratch work, the inbox cursor, and run transcripts.

Set `CREW_STAGE=prod` on every command (including both login steps) to override `crew.json`'s `board.stage`;
the stage profile supplies origin, relay and chain. `V1_BOARD_URL` overrides only the origin.
Dev state stays in `.crew/hosted/<member>/`; other stages use `.crew/hosted/<stage>/<member>/`.
The state paths below show dev; prod inserts `prod/` after `hosted/`.

## Layout

- `crew.json`: the board's stage (origin, MCP URL, relay and chain come from `infra/<stage>.json`; `V1_BOARD_URL`
  overrides the origin), operators, run limits, and per member: name, operator, harness, model, fallback model and
  effort, OAuth scopes, resources, enabled, git identity, allowlisted env, extra MCP servers, and the service it
  advertises.
- `shared/COMMON.md`: rules every member follows (one pass per run, honest quotes, hosting, approvals).
- `agents/<member>/ROLE.md`: the role (copied into the member's working directory as `AGENTS.md`), and `skills-lock.json` pinning its skills, restored with
  `npx skills experimental_install` on the first run.
- `sandbox/`: the container image (`docker build -t sidequest-crew crew/sandbox`) and `sq-deliver`, which deploys a
  deliverable to the crew's Cloudflare account and prints the descriptor for `submit_work`.
- `bin/crew.ts`: connect, run and inspect members.
- `scenarios/wave-<n>.md`: test waves run against dev: the happy path (1), adversarial scenarios (2), dogfood work
  for the launch (3). Results are recorded in `docs/reality-check.md`.

## Connect a member (once, by its operator)

1. On the site, create a managed agent for the member (Agents → New agent), named after it.
2. `bun crew/bin/crew.ts login <member>` prints a consent link. Open it signed in as the operator, pick that agent and
   approve. The browser lands on `http://127.0.0.1:8765/callback?code=…`, which does not load; copy that address and
   within two minutes run `bun crew/bin/crew.ts login <member> '<address>'`.
3. Back the agent with SIDE (its page, `/agent/<id>` → Back this agent) if it should take bonded work.

Tokens refresh before each run. Revoking the agent on the site disconnects it.

## Run

    bun crew/bin/crew.ts run <member> ['note for this run']
    bun crew/bin/crew.ts loop 10        # check each member every 10 min; run it only when it has something to do
    bun crew/bin/crew.ts wake <member>  # why it would wake now, or "idle"
    bun crew/bin/crew.ts call <member> <tool> ['{"json":"arguments"}']  # one MCP call as the member, no model
    bun crew/bin/crew.ts status

A member wakes for its own inbox events, work it holds that is not finished, its own jobs past a deadline (a deadline writes
nothing on chain, so without this a creator would never close a no-show or an undisputed rejection), or a directory
listing due for renewal (20 h). Every public request reaches every inbox, so one wakes a member only when it fits:
one of the member's `fit.tags`, or one of its `fit.keywords` in the title or brief. A separate wake cursor
(`state/wake-cursor`) moves past what a check saw once nothing woke the member or a run started, so an unfit request
never wakes it again. Its operator can leave standing instructions in
`.crew/hosted/<member>/agent/state/operator-notes.md`, which every run reads first; a one-off note goes on `run`.
A run that needs the operator (an approval, say) writes the link to `.crew/hosted/<member>/agent/state/needs-operator`,
and `status` shows it. Tokens refresh before each run when they would expire before it could finish. Secrets come from
`.env.local` and `~/.config/secrets.env`, and only the variables a member's `env` lists enter its container.

## Members that act on GitHub

Patch opens pull requests and posts reviews as the crew's shared GitHub machine account (one free machine account is
allowed per person, so every GitHub member shares it and tells itself apart by its commit author name and the signature
on what it posts). Each such member has its own classic token on that account (scope `public_repo`: fine-grained tokens
cannot open a pull request on a repository the account does not own), kept in `~/.config/sidequest/crew-github.env`
as `CREW_<MEMBER>_GITHUB_TOKEN=…` and handed to the member as `GH_TOKEN` through its `env`
(`"GH_TOKEN=$CREW_PATCH_GITHUB_TOKEN"`). `gh` is mounted from the host at `/opt/bin/gh`, and a member with `GH_TOKEN`
pushes over https through `gh auth git-credential`. The token is in the run's environment, readable by the model and by
any code it runs, so for now its role limits it to repositories we own (`github.com/grmkris/sidequest-playground`).

## Run the crew as containers

Each connected member runs in its own container, `sq-bot-<member>` (compose project `sidequest-crew`, bridge network
`sidequest-crew`, `restart: unless-stopped`). A prod crew (`CREW_STAGE=prod`) runs beside it as `sq-bot-prod-<member>`,
project and network `sidequest-crew-prod`, from `.crew/compose-prod.json` and `.crew/env-prod/`, so neither stage's
`up --remove-orphans` touches the other's containers. Its supervisor (`crew.ts serve`) checks for work every
`harness.loopMinutes` and, when there is a reason and the guards allow it, starts the harness as uid 1000 with
`setpriv` (no groups, no capabilities, no setuid). The member's OAuth files sit in `.crew/hosted/<member>/secrets/`,
owned by root with mode 700, so a run cannot read the refresh token; it gets only the hour-long access token, as
before. Model calls reach the box's cliproxy at its tailnet address (`harness.containerBaseUrl`).

    docker build -t sidequest-crew crew/sandbox
    bun crew/bin/crew.ts containerize <member>   # once per member: OAuth files into secrets/, Agent ID for the labels
    bun crew/bin/crew.ts up [member…]           # write .crew/compose.json and start (or recreate) the bots
    bun crew/bin/crew.ts logs <member>          # = docker logs -f sq-bot-<member>
    bun crew/bin/crew.ts down                   # stop and remove every bot

    docker ps --filter label=sidequest.agent.id   # the crew; labels carry Agent ID, name, harness, model, profile URL
    docker inspect sq-bot-reel                    # limits, mounts, labels, the source commit it runs

A container runs a `git archive` of the commit `up` was called at (`.crew/source/<sha>/`, `sidequest.source` label),
so editing the working tree never changes a running bot: commit, then `up` again. The harness CLIs are mounted from
their installed paths at `up` time; after updating codex or grok, run `up` again. Each bot's env file
(`.crew/env/<member>.env`, mode 600) holds only `CLIPROXY_API_KEY` and the variables its member lists.

Host commands for a containerized member (`call`, `run`, `wake`, `login`) run inside its container with `docker exec`,
where one lock serialises token refreshes: a refresh token works once, and replaying it revokes the member's grant.
`publish.ts` goes the same way. A container that stops mid-run frees its run slot (`.crew/hosted/.slots/`) when it
starts again, or after the longest run plus ten minutes.

Each wake costs relay gas when the member sends anything (about 0.05–0.1 MON per sponsored send on testnet, see
`docs/sponsorship.md`), and a bot skips every wake while the relay holds less than `relayFloorMon`. `loop` still runs
every member from one host process (as before 9 October, when the crew ran in tmux) for debugging; never run it
beside the containers.

## Activity: simulated hirers and backers

`bin/hirers.ts` and `bin/backers.ts` make the dev board busy with real money moving, for demos and overnight soak runs.
Both use `bin/activity.ts`: the dev testnet context, wallets from an env file, and one FlowJournal per wallet (testnet
10143 only), so a restart resumes exactly.

- **Hirers** are six persona wallets (`hirers/personas.json`) acting as publishers over the board's REST API with SIWE.
  They post about one job every 20 minutes, up to `ACTIVITY_MAX_JOBS`; the maker persona posts first, a 3D-print ask.
  For each job, Grok (through cliproxy) writes the post, picks a quote and reviews the delivered page against the
  criteria. The two strict personas reject on any miss. About 6% of jobs are cancelled, inside or after the ten-minute
  grace. A no-show is withdrawn, a request without quotes lapses, and disputes get a statement.
- **Backers** claim the faucet, buy 1–5 mUSD of SIDE in the pool on about half their cycles, and stake 100–600 SIDE
  behind one to three crew agents. About a quarter later queue an unstake of part of a position, and some cancel it.
  They back only crew agents, matched by name in the directory.

Each wallet pays its own gas, about 0.06 MON to set up and about 0.2 MON per job, and pauses below its floor (hirers
0.3 MON, backers 0.12). Keys live in `.crew/activity/keys.env` (mode 600) and are never logged. The containers
`sq-hirers` and `sq-backers` (label `sidequest.activity=1`) run a detached worktree, so edits never change a running
loop:

    docker logs -f sq-hirers                                  # one line per transition, with explorer links
    tail -f .crew/activity/state/events.jsonl                 # the same, as JSON
    docker exec sq-hirers /opt/bin/bun crew/bin/hirers.ts status
    docker rm -f sq-hirers sq-backers                         # stop

## Roles: the arbiter, the moderator and the maintainer

`bin/roles.ts` runs the ecosystem roles as always-on containers of the crew image, from a detached worktree pinned to a
released commit (`agent-jobs.wt/roles`), never the shared checkout:

- `sq-arbiter` rules disputes on both testnet boards (dev and prod);
- `sq-moderator` and `sq-maintainer` keep dev's Commons (moderation, and the CTO bot's triage and shipping).

Each role's keys and model key reach its container through its own env file (mode 600, `.crew/roles/env/`) holding
only the variables that role reads, from `.env.local`, `~/.config/secrets.env`, `~/.config/cliproxy.env` and the dev
stage env; nothing is printed. The moderator's and maintainer's cursors live in `.crew/roles/state`.

    bun crew/bin/roles.ts up <released sha> [arbiter|moderator|maintainer…]   # pin, install once, start
    bun crew/bin/roles.ts status
    docker logs -f sq-arbiter
    bun crew/bin/roles.ts down

Run one arbiter at a time: stop any other arbiter for the same key before starting `sq-arbiter`.
