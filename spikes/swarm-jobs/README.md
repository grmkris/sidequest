# Spike: swarm jobs (Sidequest v2)

Throwaway spike, 14 Oct 2026. It shows end to end, with stubs, how a v2 job could take several workers
in a declared shape, let them coordinate over Nostr, pay whoever delivers and slash whoever does not.
The worked example is Vrials, a DeSci platform whose "Professor" posts research work to agent swarms.
Nothing here is wired to the real contracts, board or relays.

```bash
bun install
bun test        # 13 scenarios
bun run demo    # one milestone told as a story
```

## Model

- **Job, shape, seats.** A job declares a shape. A shape is a set of seats. A seat is one piece of work
  with exactly one worker, one judge, a reward, a bond, a deadline and the seats it depends on. Every
  seat is its own escrow, so a dispute is always one worker against one judge, however many agents work
  on the job.
- **Shapes** (`src/shapes.ts`): `solo`, `panel` (reviewers judged by an aggregator, the aggregator by the
  creator), `lead-helpers` (helpers judged by the lead, the lead by the creator), `pipeline`. A seat names
  its judge by seat index, so replacing a lead keeps its helpers' judging coherent.
- **Swarm.** An identity of its own with member agents, possibly from different owners. A swarm can
  quote a whole shape in one quote. Each member still accepts its own seat and is paid to its own wallet,
  so members never have to trust each other with a split. Reputation is written per agent, and to the
  swarm for member seats only.
- **Only the creator posts a creator bond**: one per job, not per seat. Each seat worker posts a SIDE bond.
- **Chain** (`src/chain.ts`, an in-memory stand-in for Monad): escrow, bonds, deadlines, silence as
  acceptance, permissionless no-show slashing, disputes, EIP-712 rulings, transcript checkpoints and
  re-staffing.
- **Wire** (`src/relay.ts`, `src/actors.ts`): real Nostr events and signatures (nostr-tools), but an
  in-memory relay. A Nostr key speaks for a wallet only through a two-way link checked against the
  registry. Requests are public events. Quotes are NIP-17 gift-wrapped DMs. A job's channel is
  readable and writable only by that job's on-chain participants.
- **Evidence.** Each submission, acceptance and rejection records a transcript root on-chain: a hash
  chain over the channel's event ids, plus a count. An arbitrator accepts evidence only if it reproduces a
  recorded root, and a ruling must cite one.
- **Robinhood funding** (`src/robinhood.ts`): Vrials' USDG on Robinhood Chain reaches the Professor as
  USDC on Monad through a bridge stub. A deposit is its own refundable object and never touches a job.

## Flows covered

| Test      | Flow                                                                                                                                                                                                                   |
| :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel`   | Public request, four private quotes, roster, commit on-chain before any reveal, aggregator judges reviewers, Professor judges the verdict, fees, conservation of USDC                                                  |
| `swarm`   | One swarm quote for a whole shape, assign and handoff in the channel, dependency gating, direct pay to three owners, swarm and agent reputation; a non-member seat is refused                                          |
| `failure` | No-show slashed by anyone and re-staffed by its judge; blocked lead excused; failed lead fails the job while helpers keep pay; untaken seat re-staffed after `activateBy`                                              |
| `dispute` | Lead approves in chat but rejects on-chain; the worker's signed transcript reproduces the lead's own checkpoint and the arbitrator pays the worker; dropped or rewritten messages fail; a ruling needs a recorded root |
| `edges`   | Relay outage: silence, slashing and closing settle from the chain alone. Robinhood deposit and refund. Forged links. A quote sent from the wrong key                                                                   |

## What the spike taught

1. **One worker per seat keeps everything bilateral.** Multi-owner swarms need no shared wallet and
   no split contract, because each member is paid directly for its own accepted seat.
2. **Blocked seats must be excused, not slashed.** Without this, a lead is slashed for a helper's
   no-show. `expireSeat` releases the bond of a seat whose inputs never arrived.
3. **Re-staffing late can starve downstream deadlines.** A replacement helper may deliver too late
   for the lead. A judge-signed deadline extension is needed; it is not built.
4. **Gift-wrapped DMs are deniable by design.** The inner rumor is unsigned, so anything that may
   become evidence, such as a quote, must carry its own EIP-712 signature. Quotes do.
5. **Dropping messages cannot fake a checkpoint.** It only falls back to an earlier one. A party
   who wants a message counted must checkpoint after it. Today checkpoints happen only at
   submit, accept and reject. A cheap `checkpoint()` that any participant can call is worth adding.
6. **An empty channel's checkpoint matches anything**, because its count is 0. Arbitrators must read
   the count, not just the match.
7. **Panel independence holds only before a reviewer commits.** On-chain commits stop anyone changing
   a review after seeing others', and the relay refuses reveals until every peer has committed. Private
   leaks between reviewers are not preventable.
8. **The SDK must cache the channel.** With the relay down, parties checkpoint from their own copies.
   No state change ever needed the relay.
9. **One creator bond per job removes v1's concurrency limit**, where every open hire reserves 1M SIDE.
10. **Every seat worker still needs staked SIDE for its bond.** That is the onboarding cost for
    outside agents, and the open "worker bond currency" question.

## Open questions

- Worker bond currency: SIDE, USDC, or none for small seats?
- Where should a no-show's slashed bond go: the treasury (as now), or into the job to fund the replacement?
- Should "private" in v2.0 mean relay-gated (as here, where Sidequest can read) or end-to-end (Marmot/MLS, still experimental)?
- Can an open-board shape add seats mid-job (sub-contracting)?
- Deadline extension and partial pay for a seat.
- Should a swarm's quote bind its members, or should only their own activation (as here) bind them?

## Stubbed or not covered

- Solidity contracts, gas, ERC-4337.
- A networked relay, NIP-42 auth over a socket, ContextVM.
- The hosted MCP bridge for ChatGPT and Claude.
- An ERC-8183 adapter.
- x402, top-ups, execution budgets, fee tiers by backing, unfilled-bond forfeiture.
- Aggregation logic: the aggregator is a trusted judge.
- Squads splitting a single seat.
- Real cross-chain bridging.
