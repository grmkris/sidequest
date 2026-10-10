# Mainnet runbook (Sidequest v1)

The launch sequence for Sidequest v1 on Monad mainnet (chain 143), in the order `contracts/script/rehearse-launch.sh`
(R7) runs it on a fork. Every step that sends a mainnet transaction is marked **[tx]** and runs only on Kris's explicit
go. Commands run in one bash session at the repo root (§2). A contracts step runs in an explicit
`(cd contracts && set -a && . ../.env.local && set +a && …)` subshell, and a root read sources `./.env.local` in its own
subshell. Every read names its `--rpc-url`, and RPC URLs and API keys are never printed. Signing keys never come from
`.env.local`: every mainnet transaction signs from an encrypted Foundry keystore (§2).

The **development** stage serves `dev.sidequest.exchange`; prod serves `sidequest.exchange`. Each has its own
remote state and resources; both use Monad testnet until the mainnet gate described below. See [stages](stages.md).

## Launch decisions (Kris, 7 October)

- **Gate.** Mainnet goes only after A01–A08 (the agent-first acceptance list) are recorded on the production stage
  while it runs on testnet, and R7 has passed again on the commit that launches. There is no fixed date; if the gate
  is not green before the 13 October submission, the submission goes out on testnet.
- **Stages.** `sidequest.exchange` (prod) runs on testnet, sharing dev's contracts, until the launch. At launch it
  flips to 143 through `infra/prod.json` and a redeploy; `dev.sidequest.exchange` stays on testnet.
- **Safe.** Kris's wallet `0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471` plus an offline backup owner, threshold 1, so
  `SafeAccept.s.sol` runs as scripted.
- **Allocation.** Treasury (200M) and ecosystem (100M) go to the Safe. Team vesting (150M) goes to Kris's wallet,
  starting one year after T0 and running three years, with no cliff. Liquidity (50M) goes to a fresh seeder key.
- **Keys.** Fresh relay, attester and arbitrator keys for 143 only. Rotating the other credentials exposed on 1 October
  happens after the launch.
- **Disclosure.** Explore's footer and sidebar say the contracts are unaudited; there is no separate terms page.

## 0. What is already proven, without a mainnet transaction

- **The whole launch on a fork of 143 (R7).** `RPC=https://rpc.monad.xyz bash contracts/script/rehearse-launch.sh`
  runs §3.1–§3.7 and a first hire and mining epoch against the live chain's state, with Monad gas pricing and anvil
  dev keys. It passed on main c6fd84e (2 Oct). The D16 launch gate refused while the six handovers were pending and
  passed after `SafeAccept`, and `SeedPool`'s receipt verification ran against forge's real run log. The budget in §2
  comes from that run. The stake vault, the Sidequest reset and the launch scripts changed since c6fd84e, so R7 must pass
  again on the launching commit before the go.
- **Fork tests** (`(cd contracts && set -a && . ../.env.local && set +a && forge test --match-path 'test/fork/*')`):
  - `SidequestRehearsal.t.sol`: the recipe step by step on a mainnet fork, with third-party calls between the steps; a
    fresh core whose admin roles move to the Safe; the Safe accepts every handover; one hire end to end against the
    real ERC-8004 registries.
  - `SeedPoolRehearsal.t.sol`: the seed on the live Uniswap v4 contracts. It covers junk-priced and dusted pools,
    the repair cap, the fallback key, an unrelated mint racing the seed, the run-log verification and the owner checks.
  - `SafeAcceptRehearsal.t.sol`: the six acceptances through a real Safe (testnet's).
- **Delegated (EIP-7702) wallets.** Every v1 signature check goes through `contracts/src/Signatures.sol`: ecrecover
  first, then ERC-1271. A 7702-delegated EOA's own ECDSA signature works whatever its delegation's ERC-1271 does.
- **The Cloudflare stack is network-agnostic.** `SIDEQUEST_NETWORK=monad-mainnet` points the API, the indexer and
  Explore at chain 143, the mainnet RPC and `https://monad.hypersync.xyz`. The `prod` stage has its own D1, R2 and
  Durable Objects.
- **Testnet first (G1).** `contracts/script/launch-testnet.sh` runs the same deploy, promote, accept and readback on
  testnet with a fresh core and prints every transaction hash; record them in `docs/reality-check.md`.

## 1. Inputs, before anything is sent

1. **The Safe (R2).** A Safe v1.4.1 on 143. The canonical contracts have code there:
   - SafeProxyFactory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`;
   - SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`;
   - fallback handler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`;
   - MultiSendCallOnly `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`.

   After the deploy it owns every v1 contract and holds both core admin roles; the deployer keeps nothing (§3.6
   enforces this). `SafeAccept.s.sol` needs a **threshold-1** Safe. With a higher threshold, do §3.5 in Safe{Wallet}.
2. **`contracts/config/monad-mainnet.json`** (the coordinator commits it). The complete `sidequest` object:
   `SidequestRecipe.load` reads every row below, so DeploySidequest refuses if any is missing. Numbers are whole SIDE or
   seconds unless marked as raw token units or basis points. Leave the generated `deployment` fields absent: PromoteSidequest writes them from the receipts.

   | field | type | on chain 143 |
   | --- | --- | --- |
   | `sidequest.safe` | address | the Safe |
   | `sidequest.defaultArbitrator` | address | the fresh v1 arbitrator, = `roles.arbitrator` (enforced); per-offer arbitrators override it |
   | `sidequest.margin` | uint | seconds added to the windows when checking `expiredAt`; the reviewed default is 3600 |
   | `sidequest.minimumCreatorBond` | uint | raw SIDE units: 10000000000000000000000 (10,000 SIDE) |
   | `sidequest.maxMinimumCreatorBond` | uint | immutable cap in raw SIDE units: 100000000000000000000000 (100,000 SIDE) |
   | `sidequest.unfilledForfeitBps` | uint | initial never-activated forfeiture: 2500 bps, capped at 5000 |
   | `sidequest.schedule.thresholds` | uint[4] | fee tiers in whole SIDE: `[0, 10000, 100000, 1000000]` |
   | `sidequest.schedule.bps` | uint[4] | fee per tier: `[3000, 1000, 300, 100]` |
   | `sidequest.schedule.treasury` | address | the Safe |
   | `sidequest.allocation.treasury` | address | the Safe (200M SIDE) |
   | `sidequest.allocation.ecosystem` | address | the ecosystem holder (100M) |
   | `sidequest.allocation.liquidity` | address | the account that seeds the pool (50M) |
   | `sidequest.vesting.beneficiary` | address | the team (150M, vested) |
   | `sidequest.vesting.startOffset` | uint | seconds after T0 before vesting starts, e.g. 31536000 (one year) |
   | `sidequest.vesting.duration` | uint | vesting length in seconds, e.g. 94608000 (three years) |
   | `sidequest.vesting.cliff` | uint | seconds, e.g. 0 |
   | `sidequest.mining.genesis` | uint | epoch 0 start in unix seconds; 0 means the deploy time |

   Then, outside `sidequest`:
   - `liquidity.positionOwner` = the Safe; `maxRepairCost` = 5.
   - `knownTokens` = [USDC] (= `x402.usdc`). Leave `deployment.rewardTokens` absent: PromoteSidequest derives [USDC] from
     it, and refuses a mainnet reward list without USDC. The artifact's `deployment.rewardTokens` pins the same list.
   - Hold gates stay 0 and there is no faucet.

   SIDE is fixed-supply. The deploy mints exactly 1e9 once, split 50% mining reserve, 20% treasury, 15% team
   vesting, 10% ecosystem and 5% liquidity; nothing can mint again.
3. **The reviewed production artifact** (`docs/p0-prod-artifact.json`, filled after §3.3). It records:
   - the deployment addresses, including `deployment.sidequest.safe`;
   - the Safe policy the launch gate reads back (§3.6): `deployment.sidequest.safeOwners`, the exact owner set, and
     `deployment.sidequest.safeThreshold`;
   - the Privy app id and approval;
   - the RPC and HyperSync providers;
   - `admission.drain` (§3.8, §3.10).

   `bun scripts/preflight-prod.ts <artifact>` checks its structure.
4. **Domain.** `prod` serves only `sidequest.exchange`; development serves only `dev.sidequest.exchange`.
   No apex alias or domain handoff is needed. Add `https://sidequest.exchange` to the production Privy app's allowed domains.

## 2. Budget and funding [tx, by Kris from his own wallet]

From R7. Monad charges the **gas limit**, and checks a sender's balance against limit × max fee. So hold the "on hand"
column, which covers forge's 203 gwei max fee, not just the charged one.

| step | txs | gas limit | charged @ 102 gwei | on hand @ 203 gwei | paid by |
| --- | ---: | ---: | ---: | ---: | --- |
| Safe (if created by script) | 1 | 319,209 | 0.033 MON | 0.065 MON | deployer |
| DeploySidequest, fresh core | 26 | 26,300,231 | 2.683 MON | 5.339 MON | deployer |
| PromoteSidequest | 0 | 0 | 0 | 0 | — |
| SafeAccept, 6 × execTransaction | 6 | 797,168 | 0.081 MON | 0.162 MON | a Safe owner |
| SeedPool: helper, 2 approvals, seed | 4 | 3,888,439 | 0.397 MON | 0.789 MON | liquidity holder |
| Mining epoch 0: ECDSA fund, setRoot, two claims | 4 | 977,479 | 0.100 MON | 0.198 MON | a Safe owner; claimers |
| **launch total** | **41** | **32,282,526** | **3.29 MON** | **6.55 MON** | |

Keep the role wallets separate; each has its own key.

**Keystores, mandatory on mainnet.** No mainnet key goes on a command line or into `.env.local`; `--private-key` is a
testnet fallback only. Each key that sends here lives in an encrypted Foundry keystore, unlocked by a password file
you own with mode 600. Import each one once, on the box that sends: the deployer as `sidequest-deployer`, the Safe owner
as `sidequest-safe-owner`, the liquidity holder as `sidequest-liquidity`.

Everything from here on runs in one interactive **bash** session at the repo root. Start it with `bash`: zsh, this box's
default shell, reads `read -rsp` differently, and `pwcheck` below is bash. Contract commands run in an explicit
`(cd contracts && …)` subshell that sources `../.env.local` itself; root commands that read the chain source
`./.env.local` in their own subshell. Every read names its `--rpc-url`. `.env.local` holds the RPC URLs and API keys,
never a mainnet key.

```
mkdir -p ~/.config/sidequest && chmod 700 ~/.config/sidequest   # also tightens a directory that already exists
cast wallet import sidequest-deployer --interactive   # prompts for the key and a password; nothing reaches the shell
rm -f ~/.config/sidequest/deployer.password   # an existing file would keep its old mode when overwritten
(umask 077; read -rsp 'keystore password: ' p; printf '%s' "$p" >~/.config/sidequest/deployer.password; unset p; echo)
chmod 600 ~/.config/sidequest/deployer.password
cast wallet address --account sidequest-deployer --password-file ~/.config/sidequest/deployer.password   # roles.admin
```

Before every command that signs, check the password file the way `launch-testnet.sh` does. The directory must be yours
with mode 700, the file yours with mode 600 (or 400), and neither a symlink. Define this once in the bash session; each
signing command below starts with it:

```
pwcheck() {
  local d=~/.config/sidequest
  [[ -d $d && ! -L $d && -O $d && $(stat -c %a "$d") == 700 && -f $1 && ! -L $1 && -O $1 && $(stat -c %a "$1") =~ ^[46]00$ ]] \
    || { echo "refusing: $1 or $d is not yours with mode 600/700" >&2; return 1; }
}
```

The keystore is `~/.foundry/keystores/sidequest-deployer`. Delete any other copy of the raw key. The relay and attester
keys are not used here; they live in the production secret sources.

**Fresh keys (R2) first.** The relay and attester keys were exposed on 1 Oct, and the arbitrator key is replaced with them. Generate new relay, attester and arbitrator keys for mainnet, put only their addresses into `roles` in `config/monad-mainnet.json` and the artifact, and store the keys in the dedicated production secret sources. Never fund or configure `0xac72…9e7e`, `0x66b7…963f` or `0xc657…d632` on mainnet: the structural preflight refuses
any of them as a role or artifact address (`RETIRED_ROLE_ADDRESSES`, `apps/api/src/prod-config.ts`), and as
`sidequest.defaultArbitrator`. It also requires `sidequest.defaultArbitrator` to be `roles.arbitrator`, and on chain 143
DeploySidequest refuses either mistake before it sends anything (LAUNCH-AUDIT-FIX-001).

| role | address | send | why |
| :--- | :--- | :--- | :--- |
| admin (deployer) | `0x675269d710692d4d0d7166da11B76463577aad73` | 6.5 MON | deploy + Safe, 5.4 on hand at the max fee, plus a retry |
| liquidity holder (`sidequest.allocation.liquidity`) | from the config | 1 MON + 305 USDC | the seed (3M SIDE and $300 at $0.0001), plus the 5 USDC repair cap, which comes back unless spent |
| Safe owner that sends | from the Safe | 0.5 MON | SafeAccept, and each epoch's fund + setRoot |
| relay | `roles.relay` (a fresh R2 key) | 3 MON | must stay **above `RELAY_FLOOR_MAINNET` = 2 MON** (`packages/sdk/src/relay.ts`): the launch gate and each sponsored send check it. 3 MON leaves about 1 MON above the floor, about two sponsored hires (0.4–0.5 MON each, [sponsorship.md](sponsorship.md)); decide the launch funding and the 10 MON daily budget before opening writes |
| attester | `roles.attester` (a fresh R2 key) | 1 MON | attaches evidence |
| arbitrator | `roles.arbitrator` (a fresh R2 key) | 0.11 | signs rulings, which the relay sends. It also sends `cancelRuling` itself, to burn a recorded ruling's nonce (arbiter `cancel_ruling`). Bounded reserve: 10 cancellations at 51,848 gas (estimated on a Monad-pricing fork) × 203 gwei = 0.105 MON. Refill when below 0.05; no other use |

The arbiter process (`apps/arbiter`, a separate source from the Worker) requires
`V1_ARBITRATOR_PRIVATE_KEY` (the fresh v1 key above, which holds the cancellation reserve).

If the deployer is also the liquidity holder, send it both rows and use `sidequest-deployer` in §3.7. Space out
transfers to one wallet (Monad's reserve-balance rule; see `reality-check.md`).
Check balances with `bun scripts/reality-check.ts`, row "Mainnet readiness (B7)".

## 3. Launch sequence

### 3.1 The Safe [tx]

Create it in Safe{Wallet}, or from the factory as R7 does. Then check it:

```
(set -a && . ./.env.local && set +a && S=<safe> && R="$MONAD_MAINNET_RPC_URL" && \
  cast call --rpc-url "$R" "$S" "VERSION()(string)" && cast call --rpc-url "$R" "$S" "getOwners()(address[])" && \
  cast call --rpc-url "$R" "$S" "getThreshold()(uint256)")   # "1.4.1", the owners, the threshold
```

### 3.2 DeploySidequest [tx]

In a `contracts/` subshell. First run it without `--broadcast` as a dry run, then send:

```
pwcheck ~/.config/sidequest/deployer.password && \
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet MAINNET_GO=yes forge script script/DeploySidequest.s.sol \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --account sidequest-deployer --password-file ~/.config/sidequest/deployer.password \
  --broadcast --slow \
  --verify --etherscan-api-key "$MONADSCAN_API_KEY")
```

- It deploys a fresh core (ERC-1967 proxy), SIDE, and the v1 contracts: TeamVesting, FeeSchedule, StakeVault,
  SidequestHolding, SidequestEvaluator, EpochDistributor and MiningReserve.
- It wires them, moves both core admin roles to the Safe, and proposes each contract's ownership to the Safe
  (Ownable2Step).
- The script refuses chain 143 without `MAINNET_GO=yes`, an RPC whose chain id isn't the config's, and a broadcaster
  that isn't `roles.admin`.
- It writes nothing to config. It only writes `broadcast/sidequest/monad-mainnet.candidate.json`, and only with
  `--broadcast`.
- If it is cut off part way, re-run the same command with `--resume`.
- If `--verify` fails for a contract, run `forge verify-contract` for that address afterwards; Sourcify also works.

### 3.3 PromoteSidequest (no transaction)

```
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet forge script script/PromoteSidequest.s.sol --rpc-url "$MONAD_MAINNET_RPC_URL")
```

It verifies the candidate against forge's receipts and live state, then writes the deployment record (with the Safe
and the receipt blocks) into `config/monad-mainnet.json`. It refuses an incomplete or failed broadcast. Running it
again changes nothing. Commit the config, fill the artifact (§1.3), and run `heavy bun run check`.

### 3.4 The launch gate must refuse

```
bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live   # repo root; reads through the artifact's RPC
```

Expected: `production launch gate refused`, listing exactly the six `launch:owner:<name> is not the Safe` (vault,
feeSchedule, holding, evaluator, distributor, miningReserve). At this point the handovers are only pending. Anything
else in the list is a real problem; stop. The one exception is `launch:relay at or below RELAY_FLOOR_MAINNET`: fund the
relay (§2) and run it again.

### 3.5 The Safe accepts the six [tx]

First, the Safe must have no module and no guard. §4's funding is guarded by the Safe nonce (D18), which only
`execTransaction` advances: a module acts without it (`execTransactionFromModule`), and a guard can change what
executes. Stop if either line prints STOP, and never add a module or a guard later while §4 funds through this Safe:

```
(set -a && . ./.env.local && set +a && SAFE=<safe> && R="$MONAD_MAINNET_RPC_URL"
[ "$(cast call --rpc-url "$R" "$SAFE" 'getModulesPaginated(address,uint256)(address[],address)' \
  0x0000000000000000000000000000000000000001 10 | head -1)" = "[]" ] || echo "STOP: the Safe has a module"
[ "$(cast storage --rpc-url "$R" "$SAFE" \
  0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)" = "0x$(printf '%064d' 0)" ] \
  || echo "STOP: the Safe has a guard")
```

`launch-testnet.sh` refuses the same way, before it sends anything and again at readback. Then, with a threshold-1
Safe, sent by one owner, in a `contracts/` subshell:

```
pwcheck ~/.config/sidequest/safe-owner.password && \
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet MAINNET_GO=yes forge script script/SafeAccept.s.sol \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --account sidequest-safe-owner \
  --password-file ~/.config/sidequest/safe-owner.password --broadcast --slow)
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet forge script script/SafeAccept.s.sol --sig "check()" --rpc-url "$MONAD_MAINNET_RPC_URL")
```

With a higher threshold, propose one batch in Safe{Wallet}'s transaction builder: `acceptOwnership()` on the vault, fee
schedule, Holding, Evaluator, distributor and mining reserve, through MultiSendCallOnly. Then run the same `check()`.

### 3.6 The launch gate passes

```
bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live   # repo root; reads through the artifact's RPC
```

It must print `Sidequest v1 production launch gate passed`. It runs after the structural check, reads live state through
the artifact's public RPC (chain 143 only), and refuses on any failed read. It requires:
- the Safe set, with code, matching the artifact;
- the reviewed Safe: storage slot 0 is the canonical SafeL2 singleton (§1.1), `VERSION()` is 1.4.1, `getOwners()` is
  exactly the artifact's `safeOwners` and `getThreshold()` its `safeThreshold`, `getModulesPaginated(0x1, 10)` is
  empty, and the guard slot is zero;
- `owner() == Safe` on all six;
- the core's `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE` held by the Safe, and by the deployer for neither;
- the attester a verifier on the Evaluator;
- the relay above `RELAY_FLOOR_MAINNET`.

### 3.7 Seed the pool [tx]

In a `contracts/` subshell, sent by the liquidity holder:

```
pwcheck ~/.config/sidequest/liquidity.password && \
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet MAINNET_GO=yes forge script script/SeedPool.s.sol \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --account sidequest-liquidity \
  --password-file ~/.config/sidequest/liquidity.password --broadcast --slow)
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet forge script script/SeedPool.s.sol --sig "verify()" --rpc-url "$MONAD_MAINNET_RPC_URL")
```

It sends four transactions: deploy a one-shot `SeedHelper`, approve it for both tokens, and seed. The seed is **one**
transaction that creates a full-range SIDE/USDC position at $0.0001 (3M SIDE + $300) owned by the Safe. If someone
initialized the pool at another price first, the same transaction swaps it back, trading through whatever is in the
way, up to `maxRepairCost` (5 USDC, or that value in SIDE at the target price); above the cap it refuses.

`verify()` is the authoritative check. It takes the token id from the seed receipt, then reads back the owner,
liquidity, pool key and ticks, and checks that no allowance is left.

**Fallback pool key.** If the seed reverts with `PriceNotSet` (dust beyond the cap), set `"fee": 10000,
"tickSpacing": 200` in `liquidity`, revoke the old helper's allowances (`approve(helper, 0)` on both tokens with `cast send`, signed by the same
keystore, [tx]), and re-run both commands. A second run of a pool that was already seeded is refused (`AlreadySeeded`).

### 3.8 A drained production deploy (no chain transaction)

```
SIDEQUEST_PROD_ARTIFACT=docs/p0-prod-artifact.json PROD_ADMISSION_DRAIN=1 bun run deploy:prod   # repo root, deploy env
```

- With `admission.drain: true` in the artifact, the deploy is drained: reads and authenticated recovery work, and new
  hosted writes are refused.
- A missing or empty `PROD_ADMISSION_DRAIN` also drains, and the artifact's mode must match the runtime value.
- `assertDeployConfig` runs before any resource: structure, provider and Privy mapping, dedicated secret sources,
  the signing keys against the configured relay and attester, and the RPC's chain id. It also checks Explore's pinned
  `explore.mainnetLive`, which must equal `MAINNET_LIVE` in `apps/explore/src/release.ts` and be false while drained.
- A drained deploy skips the D16 gate, so an emergency redeploy is never blocked by it.
- **Blocker:** remote state needs verified, account-scoped **Secrets Store: Edit** permission on the Cloudflare token,
  and must be readable and map the intended resources before evaluation. Do not bootstrap state to make the preflight
  pass. Local-only production state is not an accepted fallback.

### 3.9 Post-deploy probes

- `curl <api>/health`: `ok: true`, `network: "monad-mainnet"`.
- MCP `protocol_info` shows chain 143 and the v1 addresses from the config.
- The indexer's `GET /` shows `next_block` at or past `deployment.sidequest.block` within a few minutes.
- Explore shows chain 143 and Monadscan links, and the board refuses new hosted writes (drained). Direct chain calls
  stay permissionless; draining is a hosted-admission control only.
- `bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --probe https://sidequest.exchange` must pass: the served
  `/release.json` is `{"network": "monad-mainnet", "mainnetLive": <pinned>, "writesOpen": <pinned>}`, both false here.

### 3.10 Explicit opening

1. Review and commit the artifact with `admission.drain: false` and `explore.mainnetLive: true`. In the same commit,
   set `MAINNET_LIVE = true` in `apps/explore/src/release.ts`; that line is the only source, and the preflight refuses
   an open artifact unless the pin and the source are both true. While it is false, Explore on chain 143 is read-only
   by any URL (PROD-GATE-006). Every write page shows "Launching soon", and only read tools reach the board. The build
   writes the value to `/release.json` as `{network, mainnetLive, writesOpen}`.
2. Run `bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live` again; it must pass.
3. Deploy with `SIDEQUEST_PROD_ARTIFACT=docs/p0-prod-artifact.json PROD_ADMISSION_DRAIN=0 bun run deploy:prod`. An
   opening deploy runs the D16 gate inside `assertDeployConfig` before any resource, and refuses on any failure.
4. Repeat §3.9; write paths are now live. The `--probe` check now expects `"mainnetLive": true, "writesOpen": true`.

### 3.11 The first real USDC job [tx]

A fixed-price hire on the main pair, published from Explore by Kris's own wallet. The worker is a headless Claude Code
session with `skill/worker` and a fresh mainnet key holding a little MON; it registers on the ERC-8004 Identity
Registry the first time. Record every hash in `docs/reality-check.md` under "v1 mainnet".

## 4. Mining epochs

Epoch 0 runs 72 h from genesis; each later epoch runs 7 days. Mining runs rule v2 ([ADR-0020](adr/0020-mining-volume-credit.md))
from epoch 0: `monad-mainnet.json` must carry `mining.creditRule.fromEpoch` = 0 before the first run. The price list
may hold only USD-pegged tokens from the config's `usdPegged` list, each priced within 1 % of $1, and SIDE itself only
at the factory (reference) price. The reference price needs an official pool configured in the same file; see
`docs/mainnet-gate-findings.md` (G2). Anyone can re-check a published epoch with
`bun run mining:epoch <n> --recompute <epoch-n.json> --network monad-mainnet --logs rpc --from-genesis`.
Weekly mining uses HyperSync for logs (`HYPERSYNC_API_TOKEN` by environment name); contract and block reads stay on
the configured RPC. Public and free-tier RPCs cap log ranges at 100 or fewer blocks, so independent full RPC replay
needs a large-range keyed provider. Keep the previous published v2 epoch and state in the checkpoint directory.
After an epoch ends:
1. Compute the epoch with B8 (`scripts/mining/README.md`). A Safe owner signs the epoch's price list (USD per priced
   token, the SIDE reference price):
   `pwcheck ~/.config/sidequest/safe-owner.password && bun scripts/mining/sign-prices.ts <list> --network monad-mainnet
   --out <signed> --account sidequest-safe-owner --password-file ~/.config/sidequest/safe-owner.password`. The helper
   checks the password file the same way before it signs. Then, from the repo root, run
   `(set -a && . ./.env.local && set +a && bun run mining:epoch <n> --network monad-mainnet --rpc "$MONAD_MAINNET_RPC_URL"
   --prices <signed> --out <dir> --checkpoint-dir <dir> --logs hypersync)`. It writes `epoch-<n>.json` (root, total, dataHash, tree, proofs)
   and `state-<n>.json` (the committed replay checkpoint), and prints the
   Safe's two calls.
2. The Safe sends the file's calls. `/admin`'s mining panel is the route to use: it builds both and checks them.
   - **`calls.fund`**, when present: `MiningReserve.fund(n, amount)` for the remainder the epoch still needs, not the
     file's `total`. `fund` adds to what is already there, so the Safe nonce guards it (D18):
     - Read `Safe.nonce()` and `MiningReserve.totalFunded()` at one block.
     - `totalFunded` must still equal `calls.fund.expect.totalFunded`; if it doesn't, run `bun run mining:epoch` again.
     - An owner signs the SafeTx at exactly that nonce, with ECDSA. Never use a pre-validated (v = 1) signature: it
       binds no nonce. Never re-sign a retry at a later nonce: recompute it.

     A second funding signed for that nonce then reverts (GS026), as R7 shows.
   - **`calls.setRoot`**: `EpochDistributor.setRoot(n, root, total, dataHash)`, an ordinary `execTransaction`.

   From a terminal instead, at the repo root. The script sources `.env.local` itself and stops at the first failure:
   ```
   pwcheck ~/.config/sidequest/safe-owner.password && \
   E=<dir>/epoch-<n>.json SAFE=<safe> bash -euo pipefail <<'FUND'
   set -a; . ./.env.local; set +a
   R="$MONAD_MAINNET_RPC_URL" Z=0x0000000000000000000000000000000000000000 TO=$(jq -r .calls.fund.to "$E")
   KEY=(--account sidequest-safe-owner --password-file ~/.config/sidequest/safe-owner.password)
   B=$(cast block-number --rpc-url "$R")
   NONCE=$(cast call --block "$B" --rpc-url "$R" "$SAFE" 'nonce()(uint256)')
   [ "$(cast call --block "$B" --rpc-url "$R" "$TO" 'totalFunded()(uint256)' | cut -d' ' -f1)" \
     = "$(jq -r .calls.fund.expect.totalFunded "$E")" ] || { echo "totalFunded moved: run mining:epoch again"; exit 1; }
   H=$(cast call --rpc-url "$R" "$SAFE" \
     'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
     "$TO" 0 "$(jq -r .calls.fund.data "$E")" 0 0 0 0 $Z $Z "$NONCE")
   SIG=$(cast wallet sign --no-hash "$H" "${KEY[@]}")
   cast send --rpc-url "$R" "$SAFE" 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
     "$TO" 0 "$(jq -r .calls.fund.data "$E")" 0 0 0 0 $Z $Z "$SIG" "${KEY[@]}"
   FUND
   ```
   Send `setRoot` the same way with its own `to` and `data`. It may carry the sending owner's pre-validated signature:
   `$(cast abi-encode 'f(address)' <owner>)$(printf '%064d' 0)01`. Always sign from the keystore, never with
   `--private-key`.
3. After `setRoot` and before any claim, publish the epoch file for hosted claims, at the repo root. The command reads
   `.env.local` itself (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `MONAD_MAINNET_RPC_URL`):
   ```
   bun run mining:publish <dir>/epoch-<n>.json --stage prod --state <dir>/state-<n>.json
   sha256sum <dir>/epoch-<n>.json
   ```
   It checks every proof and the total, and requires the file's root, total and `dataHash` to equal
   `EpochDistributor.rootOf(n)` on chain. It uploads the file to the production API's Manifests R2 bucket at
   `mining/epoch-<n>.json` and reads it back, comparing sha256. It prints only `mining:publish uploaded and verified`,
   or `mining:publish refused: <code>` (retry the same file). Rule v2 also validates and uploads the committed state to
   `mining/state-<n>.json`; retain the epoch/state pair for the next weekly replay.
   Record the key `mining/epoch-<n>.json` and the file's sha256, which the readback matched, in the launch evidence
   (LAUNCH-AUDIT-005). Until it has run, hosted `mining_proof` and Collect cannot find the epoch, though a direct claim
   with the file's proof still works.
4. Each claim stakes the reward into the vault for the claimant.

`fund` works only for an ended epoch and only up to the cumulative schedule (500M in all). A root can be replaced until
its first claim; `resizeRoot` corrects a total.

## 5. If something goes wrong

- **Contract bug.** The Safe pauses the core and notes the pause on the Evaluator as **one** transaction: a
  MultiSendCallOnly batch of core `pause` + evaluator `notePause` (D13), which `/admin` builds. `/admin`
  refuses a lone `pause` or `unpause`. While paused, rulings and acceptances still land, and a payout or refund the core
  refuses is deferred (`PayoutDeferred` / `RefundDeferred`) rather than reverted. `rejectAfterDeliveryDeadline` waits
  for the unpause, and a delivery deadline inside a recorded pause refunds the creator without burning the worker's
  bond. The core's `emergencyWithdraw` works only while paused and only for the Safe. Unpause is the same atomic pair;
  an unrecorded end counts as still paused.
- **A payout or refund deferred** (`PayoutDeferred` / `RefundDeferred`): anyone calls `retryDeferred(jobId)`, then
  `settle(jobId)`.
- **The seed refuses:** use the fallback key (§3.7).
- **A deploy cut off part way:** `--resume`. Promotion refuses an incomplete run, and config stays untouched.
- **Board or Worker problem.** Chain state is authoritative. Use a reviewed same-Worker version rollback, not an
  unguarded whole-stack deploy of an older commit; verify bindings and old-version compatibility first. Code rollback
  does not undo D1 schema or DO class migrations or namespace state. Preserve storage, domains and aliases; rebuild
  chain-derived rows only under a separately reviewed recovery procedure.
- **A leaked key.** Every role key is separate.
  - Relay: a new key in `roles.relay`, the artifact and the secret source, funded above the floor, then redeploy.
  - Attester: the Safe calls `setVerifier(new, true)` and `setVerifier(old, false)` on the Evaluator; update
    `roles.attester`, the artifact and the secret source, then redeploy.
  - Arbitrator: arbitrators are per offer, so new offers name a new one.
  - Deployer: it holds no role after §3.5; the launch gate proves that.

## 6. Not blocking the launch

The board's attester records evidence claims. The expired CRE workflow is archived at git tag `legacy-final`
and is not a current deployment dependency.

## 7. P0 no-mutation drills and owner alerts

Run `bun run p0:drills` locally before treating fresh production state as recoverable. The drill:
- creates disposable SQLite files under `/tmp`;
- installs the real D1, indexer, registry and session schemas, and preserves hosted rows;
- backs up and restores the database;
- runs the real indexer reset and rebuild against bounded recorded chain logs.

`bun scripts/p0-drills.ts --live-testnet` instead rebuilds from a bounded, read-only Monad testnet RPC log range (at
most 8000 blocks, 100-block pages). It never connects to remote D1, Cloudflare, HyperSync, Telegram or any production
resource.

`apps/api/test/recovery.test.ts` additionally restores and rebuilds rows in two disposable local D1 databases under
real workerd, and checks the runtime identity. Both tests retain a hosted sentinel; the Node adapter also installs the
actual hosted registry and session schemas.

Neither proves restoration of a production session or Durable Object. A local SQLite or local D1 row restore is not a
remote Cloudflare D1 restore. A backup is evidence of recoverability, not a source of truth for balances or
settlement.

The ops alert adapter emits owner-only records for uptime, indexer lag, failed publishes, stuck or owed escrows, and
unexpected admin events. Its transport is injected; tests use a fake sender and deduplicate by alert id.

The real myagent bot (`@mymanbot_bot`) is a prepared transport target, not live-enabled. This preparation track uses
no bot token, `getUpdates`, webhook or live message. An expected refusal is a metric, not an incident, and direct chain
rights stay permissionless even while hosted admission is drained. See `docs/p0-admission.md` and
`docs/p0-owner-alerts.md` for the production boundary, tests and remaining live gates.
