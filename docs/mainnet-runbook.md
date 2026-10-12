# Mainnet runbook (Sidequest v1)

The launch sequence for Sidequest v1 on Monad mainnet (chain 143), in the order `contracts/script/rehearse-launch.sh`
(R7) runs it on a fork. Every step that sends a mainnet transaction is marked **[tx]** and runs only on Kris's explicit
go. Commands run in one bash session at the repo root (§2). A contracts step runs in an explicit
`(cd contracts && set -a && . ../.env.local && set +a && …)` subshell, and a root read sources `./.env.local` in its own
subshell. Every read names its `--rpc-url`, and RPC URLs and API keys are never printed. Signing keys never come from
`.env.local`: every mainnet transaction the scripts send signs from an encrypted Foundry keystore (§2).

The **development** stage serves `dev.sidequest.exchange`; prod serves `sidequest.exchange`. Each has its own
remote state and resources; both use Monad testnet until the mainnet gate described below. See [stages](stages.md).

## Launch decisions (Kris, 11 and 12 October)

The full record is myplan note 22 (Decisions); the task list is note 23.

- **SIDE.** SIDE launches on the nad.fun launcher, created by the `sidequest-creator` keystore on Kris's MacBook
  through nad.fun's upload and salt API and its V2 router (nad.fun lists only tokens made through its API), with a 5% dev
  buy (50M SIDE) in the creation transaction. The dev buy moves to the Safe and is disclosed: 50% for
  backing positions the Safe owns, 30% for tasks the Safe funds, 20% in reserve. nad.fun's creator fee goes to the Safe.
  The protocol mints nothing: the deploy points at the existing token.
- **No mining at launch.** The mining reserve, distributor and team vesting are gone from the contracts (tag
  `mining-final` keeps the old code). Protocol fees collect in the Safe; their use is decided later.
- **Slashing.** SIDE has no `burn`, so a slash sends the bond to `0x000000000000000000000000000000000000dEaD`.
- **Gate.** Mainnet goes only after Kris's A01–A08 by hand on prod-testnet and R7 passing on the commit that launches.
- **Stages.** `sidequest.exchange` (prod) runs on testnet until the launch. At launch it flips to 143 through
  `infra/prod.json` and a redeploy; `dev.sidequest.exchange` stays on testnet.
- **Safe.** One owner, the `sidequest-owner` keystore on Kris's MacBook, and threshold 1 at launch. It becomes 2-of-3
  by 20 October 2026, in place (§3.7); the docs disclose both.
- **Keys.** Every mainnet wallet is fresh. The Safe owner, the SIDE creator and the exit-test wallet are Foundry
  keystores on Kris's MacBook, signed through `contracts/script/launch-kit.sh` (§2). The deployer, relay, attester and
  arbitrator are fresh keys on this box, for 143 only.
- **Disclosure.** Explore's footer and sidebar say the contracts are unaudited; the docs state the Safe's powers.

## 0. What is already proven, without a mainnet transaction

- **The launch on a fork of 143 (R7).** `RPC=https://rpc.monad.xyz bash contracts/script/rehearse-launch.sh` runs
  §3.1–§3.7 against the live chain's state, with Monad gas pricing and anvil dev keys: SIDE is created through the real
  nad.fun router with the 5% dev buy and the creator fee paid to the Safe, and must have no `burn`. The launch gate
  refuses while the four handovers are pending and passes after `SafeAccept` with the 1-of-1 pin. Rehearsing the 2-of-3
  due by 20 Oct, it then refuses the stale pin and passes the new one. Then two
  hires paid in SIDE (one settled, one missed whose worker bond must land in the sink) and a small buy and sell. R7
  must pass again on the launching commit before the go; it prints the exact gas budget (§2).
- **The launch kit on testnet.** `contracts/script/launch-kit.sh` made a 1-of-1 Safe and a token through nad.fun's
  testnet API (listed with its links, creator fee to the Safe), moved the dev buy, and bought and sold; its backing batch
  ran on a fork (`docs/evidence/mainnet/2026-10-12-launch-kit-dry-run.md`).
- **Fork tests** (`(cd contracts && set -a && . ../.env.local && set +a && forge test --match-path 'test/fork/*')`):
  - `SidequestRehearsal.t.sol`: the recipe step by step on a mainnet fork, with third-party calls between the steps,
    against a launcher-like SIDE (no `burn`); a fresh core whose admin roles move to the Safe; the Safe accepts every
    handover; one hire end to end against the real ERC-8004 registries.
  - `SafeAcceptRehearsal.t.sol`: the four acceptances through a real Safe (testnet's).
- **Delegated (EIP-7702) wallets.** Every v1 signature check goes through `contracts/src/Signatures.sol`: ecrecover
  first, then ERC-1271. A 7702-delegated EOA's own ECDSA signature works whatever its delegation's ERC-1271 does.
- **The Cloudflare stack is network-agnostic.** `SIDEQUEST_NETWORK=monad-mainnet` points the API, the indexer and
  Explore at chain 143, the mainnet RPC and `https://monad.hypersync.xyz`. The `prod` stage has its own D1, R2 and
  Durable Objects.

## 1. Inputs, before anything is sent

1. **The Safe (R2).** A Safe v1.4.1 on 143 with one owner, the kit's `sidequest-owner`. The canonical contracts have
   code there (`launchKit.safe` in the config):
   - SafeProxyFactory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`;
   - SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`;
   - fallback handler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`;
   - MultiSendCallOnly `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`.

   After the deploy it owns every v1 contract and holds both core admin roles; the deployer keeps nothing (§3.7
   enforces this). `SafeAccept.s.sol` needs a **threshold-1** Safe; it stays 1-of-1 through launch and becomes 2-of-3 by
   20 Oct (§3.7).
2. **`contracts/config/monad-mainnet.json`** (the coordinator commits it). The complete `sidequest` object:
   `SidequestRecipe.load` reads every row below, so DeploySidequest refuses if any is missing. Numbers are whole SIDE or
   seconds unless marked as raw token units or basis points. Leave the generated `deployment` fields absent: PromoteSidequest writes them from the receipts.

   | field | type | on chain 143 |
   | --- | --- | --- |
   | `sidequest.safe` | address | the Safe |
   | `sidequest.defaultArbitrator` | address | the fresh v1 arbitrator, = `roles.arbitrator` (enforced); per-offer arbitrators override it |
   | `sidequest.margin` | uint | seconds added to the windows when checking `expiredAt`; the reviewed default is 3600 |
   | `sidequest.minimumCreatorBond` | uint | raw SIDE units: 1000000000000000000000000 (1M SIDE) |
   | `sidequest.maxMinimumCreatorBond` | uint | immutable cap in raw SIDE units: 100000000000000000000000000 (100M SIDE) |
   | `sidequest.unfilledForfeitBps` | uint | initial never-activated forfeiture: 2500 bps, capped at 5000 |
   | `sidequest.schedule.thresholds` | uint[4] | fee tiers in whole SIDE: `[0, 1000000, 10000000, 50000000]` |
   | `sidequest.schedule.bps` | uint[4] | fee per tier: `[3000, 1000, 300, 100]` |
   | `sidequest.schedule.treasury` | address | the Safe |
   | `sidequest.token` | address | SIDE, from §3.2: the recipe checks 18 decimals, the 1e9 supply, Sidequest/SIDE, and that its code is the nad.fun clone of `nadfun.tokenImplementation` on `nadfun.curve` |

   Then, outside `sidequest`:
   - `knownTokens` = [USDC (= `x402.usdc`), SIDE]. Leave `deployment.rewardTokens` absent: PromoteSidequest takes the
     known tokens and refuses a mainnet list without USDC. Customers may pay in any token; Sidequest's own tasks pay in
     SIDE.
   - Hold gates stay 0 and there is no faucet.
3. **The reviewed production artifact** (`docs/p0-prod-artifact.json`, filled after §3.4). It records:
   - the deployment addresses, including `deployment.sidequest.safe`;
   - the Safe policy the launch gate reads back (§3.7): `deployment.sidequest.safeOwners`, the exact owner set, and
     `deployment.sidequest.safeThreshold`;
   - the Privy app id and approval;
   - the RPC and HyperSync providers;
   - `admission.drain` (§3.9, §3.11).

   `bun scripts/preflight-prod.ts <artifact>` checks its structure.
4. **Domain.** `prod` serves only `sidequest.exchange`; development serves only `dev.sidequest.exchange`.
   No apex alias or domain handoff is needed. Add `https://sidequest.exchange` to the production Privy app's allowed domains.

## 2. Budget and funding [tx, funded by Kris]

Monad charges the **gas limit**, and checks a sender's balance against limit × max fee. R7 on the launching commit
prints each step's limit and gasUsed; hold twice its charged total. The earlier launch (which also deployed SIDE,
vesting and mining) took 26 deploy transactions and 26.3M gas, so the deployer's 6 MON below is ample.

| step | sends | paid by |
| --- | --- | --- |
| Safe (`launch-kit.sh safe send`) | 1 | the owner keystore (Mac) |
| nad.fun creation with the 5% dev buy | 1 | the creator keystore (Mac): about 3,544 MON; the deploy fee is 0 today, and the kit re-reads it |
| dev buy to the Safe | 1 | the creator keystore (Mac) |
| DeploySidequest, fresh core | R7 | deployer |
| PromoteSidequest | 0 | — |
| SafeAccept, 4 × execTransaction | 4 | the owner keystore (Mac) |
| backing batch (§3.8) | 1 | the owner keystore (Mac) |
| exit test, buy and sell (§3.12) | 3 | the exit-test keystore (Mac) |
| 2-of-3 by 20 Oct: addOwnerWithThreshold ×2 | 2 | the owner keystore (Mac), after launch day |

Keep the role wallets separate; each has its own key.

**Keystores, mandatory on mainnet.** No mainnet key goes on a command line or into `.env.local`; `--private-key` is a
testnet fallback only. Each key that sends here lives in an encrypted Foundry keystore, unlocked by a password file
you own with mode 600. Import each one once, on the box that sends: the deployer as `sidequest-deployer` here.

**The keys on Kris's MacBook** (decided 12 Oct, myplan note 22). The Safe owner, the SIDE creator and the exit-test
wallet sign through `contracts/script/launch-kit.sh` in a clone of this repo on the Mac. Kris creates them himself, in
Terminal; agents never make them:

```
NETWORK=monad-mainnet contracts/script/launch-kit.sh setup   # three keystores; passwords go into Keychain unseen
```

Each password is a login-Keychain item that trusts no application, so every read shows Kris a macOS prompt. He must
click **Allow**, never **Always Allow**. Back up each password into the Passwords app (`copy-password <name>`) and the
keystores to an encrypted place (`backup <dir>`). A Claude Code session on the Mac runs every kit step twice:
- `plan` reads, uploads and simulates, and signs nothing;
- `send` re-checks, takes one Keychain prompt, sends, and reads the result back.

A mainnet `send` needs `MAINNET_GO=yes`, given only after Kris's go, and refuses keystores an agent made for a testnet
dry run. The steps and their outputs pass through the myplan launch desk note (L0); Claude on this box checks each one
on chain.

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

Before every command that signs, check the password file: the directory must be yours with mode 700, the file yours
with mode 600 (or 400), and neither a symlink. Define this once in the bash session; each signing command below starts
with it:

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
| admin (deployer) | `roles.admin`, the fresh `sidequest-deployer` (never the old `0x6752…ad73`) | 60 MON | deploy (about 2.4 MON at 102 gwei) with room for a retry; the relay, arbiter and crew top-ups go out from it (§3.8) |
| Safe owner (Mac kit) | `launch-kit.sh addresses` | 2 MON | the Safe, SafeAccept and the backing batch |
| creator (Mac kit) | `launch-kit.sh addresses` | about 3,600 MON | the 5% dev buy (about 3,544 MON) and gas; the kit's margin is refunded |
| exit test (Mac kit) | `launch-kit.sh addresses` | about 20 MON | the small buy and sell (§3.12) |
| relay | `roles.relay` (a fresh R2 key) | 3 MON | must stay **above `RELAY_FLOOR_MAINNET` = 2 MON** (`packages/sdk/src/relay.ts`): the launch gate and each sponsored send check it. 3 MON leaves about 1 MON above the floor, about two sponsored hires (0.4–0.5 MON each, [sponsorship.md](sponsorship.md)); decide the launch funding and the 10 MON daily budget before opening writes |
| attester | `roles.attester` (a fresh R2 key) | 1 MON | attaches evidence |
| arbitrator | `roles.arbitrator` (a fresh R2 key) | 0.11 | signs rulings, which the relay sends. It also sends `cancelRuling` itself, to burn a recorded ruling's nonce (arbiter `cancel_ruling`). Bounded reserve: 10 cancellations at 51,848 gas (estimated on a Monad-pricing fork) × 203 gwei = 0.105 MON. Refill when below 0.05; no other use |

The arbiter process (`apps/arbiter`, a separate source from the Worker) requires
`V1_ARBITRATOR_PRIVATE_KEY` (the fresh v1 key above, which holds the cancellation reserve).

Space out transfers to one wallet (Monad's reserve-balance rule; see `reality-check.md`).

## 3. Launch sequence

### 3.1 The Safe [tx]

On the Mac, with the kit (canonical factory and SafeL2, a salt nonce fixed per owner and network, so a second send
cannot make a second Safe; the kit checks the threshold, the module list and the guard slot):

```
NETWORK=monad-mainnet contracts/script/launch-kit.sh safe plan
MAINNET_GO=yes NETWORK=monad-mainnet contracts/script/launch-kit.sh safe send
```

Then check it from this box:

```
(set -a && . ./.env.local && set +a && S=<safe> && R="$MONAD_MAINNET_RPC_URL" && \
  cast call --rpc-url "$R" "$S" "VERSION()(string)" && cast call --rpc-url "$R" "$S" "getOwners()(address[])" && \
  cast call --rpc-url "$R" "$S" "getThreshold()(uint256)")   # "1.4.1", [the owner], 1
```

Before any SIDE reaches it, the Safe must have no module and no guard: a module acts without the owners' signatures
(`execTransactionFromModule`), and a guard can change what executes. Stop if either line prints STOP, and never add a
module or a guard later:

```
(set -a && . ./.env.local && set +a && SAFE=<safe> && R="$MONAD_MAINNET_RPC_URL"
[ "$(cast call --rpc-url "$R" "$SAFE" 'getModulesPaginated(address,uint256)(address[],address)' \
  0x0000000000000000000000000000000000000001 10 | head -1)" = "[]" ] || echo "STOP: the Safe has a module"
[ "$(cast storage --rpc-url "$R" "$SAFE" \
  0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)" = "0x$(printf '%064d' 0)" ] \
  || echo "STOP: the Safe has a guard")
```

### 3.2 SIDE on nad.fun [tx, the creator keystore on the Mac]

nad.fun lists only tokens whose metadata and salt come from its API, and the token's `tokenURI` is permanent. The kit
uploads the Sidequest mark and `docs/brand/nadfun-token.json` (the utility-only description, the website, X and Telegram
links) to `api.nad.fun` and reads the stored metadata back. It then asks for a V2 salt, checks the predicted address
(ending 7777) with `cast create2` and that it has no code, re-reads the deploy fee, and simulates `createWithNative`:
name Sidequest, ticker SIDE, a 5% dev buy in the same transaction (50M SIDE; about 3,544 MON), and the creator-fee
vault paying the Safe. The salt stays in the kit's state until the send; never post it.

```
NETWORK=monad-mainnet SAFE=<safe> contracts/script/launch-kit.sh token plan
MAINNET_GO=yes NETWORK=monad-mainnet SAFE=<safe> contracts/script/launch-kit.sh token send
```

After the send the kit checks code, 18 decimals, the 1e9 supply, `getCreator(token)` on the creator-fee vault equal to
the Safe (as R7 does), and the listing on nad.fun's API. Then read the token back from this box; every line must
match:

```
(set -a && . ./.env.local && set +a && T=<SIDE> && R="$MONAD_MAINNET_RPC_URL" && \
  cast call --rpc-url "$R" "$T" "totalSupply()(uint256)" && cast call --rpc-url "$R" "$T" "decimals()(uint8)" && \
  cast call --rpc-url "$R" "$T" "symbol()(string)" && cast call --rpc-url "$R" "$T" "nonces(address)(uint256)" "$T")
# 1000000000000000000000000000, 18, "SIDE", 0 (permit is present)
```

Take the address only from the creation transaction's `Create(token, creator)` log, emitted by the router
`nadfun.router`, with `creator` equal to the kit's creator address: nad.fun does not enforce unique tickers, and
DeploySidequest refuses any token that is not a clone of `nadfun.tokenImplementation` on `nadfun.curve`. Send the
dev-buy SIDE to the Safe [tx] with `MAINNET_GO=yes NETWORK=monad-mainnet SAFE=<safe> contracts/script/launch-kit.sh move
send` (after `move plan`) and read the Safe's balance back from this box:

```
(set -a && . ./.env.local && set +a && T=<SIDE> && S=<safe> && R="$MONAD_MAINNET_RPC_URL" && \
  cast call --rpc-url "$R" "$T" "balanceOf(address)(uint256)" "$S")   # the whole dev buy, about 50M SIDE
```

Then write `sidequest.token` and add SIDE to `knownTokens` in `config/monad-mainnet.json` (PromoteSidequest
refuses a mainnet reward list without USDC and SIDE), and commit. Publish the address only from the site and the
official accounts.

### 3.3 DeploySidequest [tx]

In a `contracts/` subshell. First run it without `--broadcast` as a dry run, then send:

```
pwcheck ~/.config/sidequest/deployer.password && \
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet MAINNET_GO=yes forge script script/DeploySidequest.s.sol \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --account sidequest-deployer --password-file ~/.config/sidequest/deployer.password \
  --broadcast --slow \
  --verify --etherscan-api-key "$MONADSCAN_API_KEY")
```

- It deploys a fresh core (ERC-1967 proxy) and the v1 contracts against the existing SIDE: FeeSchedule, StakeVault,
  SidequestHolding and SidequestEvaluator. It mints nothing and refuses a token without code, 18 decimals and the 1e9
  supply.
- It wires them, moves both core admin roles to the Safe, and proposes each contract's ownership to the Safe
  (Ownable2Step).
- The script refuses chain 143 without `MAINNET_GO=yes`, an RPC whose chain id isn't the config's, and a broadcaster
  that isn't `roles.admin`.
- It writes nothing to config. It only writes `broadcast/sidequest/monad-mainnet.candidate.json`, and only with
  `--broadcast`.
- If it is cut off part way, re-run the same command with `--resume`.
- If `--verify` fails for a contract, run `forge verify-contract` for that address afterwards; Sourcify also works.

### 3.4 PromoteSidequest (no transaction)

```
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet forge script script/PromoteSidequest.s.sol --rpc-url "$MONAD_MAINNET_RPC_URL")
```

It verifies the candidate against forge's receipts and live state, then writes the deployment record (with the Safe
and the receipt blocks) into `config/monad-mainnet.json`. It refuses an incomplete or failed broadcast. Running it
again changes nothing. Commit the config, fill the artifact (§1.3), and run `heavy bun run check`.

### 3.5 The launch gate must refuse

```
bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live   # repo root; reads through the artifact's RPC
```

Expected: `production launch gate refused`, listing exactly the four `launch:owner:<name> is not the Safe` (vault,
feeSchedule, holding, evaluator). At this point the handovers are only pending. Anything else in the list is a real
problem; stop. The one exception is `launch:relay at or below RELAY_FLOOR_MAINNET`: fund the relay (§2) and run it again.

### 3.6 The Safe accepts the four [tx]

The Safe still has no module and no guard (§3.1). Pull the promotion commit on the Mac; the kit refuses unless the
config's promoted Safe is its own. It runs `SafeAccept.s.sol` (one `execTransaction` per contract, the owner's
pre-validated signature) from the owner keystore, with `MAINNET_GO`:

```
NETWORK=monad-mainnet contracts/script/launch-kit.sh accept plan
MAINNET_GO=yes NETWORK=monad-mainnet contracts/script/launch-kit.sh accept send
```

Then read the four owners back from this box:

```
(cd contracts && set -a && . ../.env.local && set +a && \
  NETWORK=monad-mainnet forge script script/SafeAccept.s.sol --sig "check()" --rpc-url "$MONAD_MAINNET_RPC_URL")
```

### 3.7 The launch gate passes

```
bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live   # repo root; reads through the artifact's RPC
```

It must print `Sidequest v1 production launch gate passed`. It runs after the structural check, reads live state through
the artifact's public RPC (chain 143 only), and refuses on any failed read. It requires:
- the Safe set, with code, matching the artifact;
- the reviewed Safe: storage slot 0 is the canonical SafeL2 singleton (§1.1), `VERSION()` is 1.4.1, `getOwners()` is
  exactly the artifact's `safeOwners` and `getThreshold()` its `safeThreshold`, `getModulesPaginated(0x1, 10)` is
  empty, and the guard slot is zero;
- `owner() == Safe` on all four;
- the core's `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE` held by the Safe, and by the deployer for neither;
- the attester a verifier on the Evaluator;
- the relay above `RELAY_FLOOR_MAINNET`.

At launch the artifact pins `safeOwners` to the one owner and `safeThreshold` to 1; nothing changes the threshold on
launch day. Every opening deploy reruns the gate.

**After launch, by 20 October [tx]:** the Safe becomes 2-of-3 in place, with nothing moved. Two Safe transactions to
itself, sent by the owner: `addOwnerWithThreshold(address,uint256)` with the second owner and 1, then the third owner
and 2 (R7 step 5 rehearses this). Read `getOwners()` and `getThreshold()` back, set `safeOwners` and `safeThreshold`
(2) in the artifact, commit, and run the gate again: it must pass.

### 3.8 Fund the operation [tx]

Fund the relay, arbiter and crew wallets with MON from the deployer (§2). From the dev buy's backing half, the Safe
backs the official account (5M SIDE) and each crew agent (2.5M): one Safe transaction through MultiSendCallOnly of
`approve(vault, total)` on SIDE followed by `delegateFor(account, safe, amount)` for each account, so the Safe keeps each
position. The 1-of-1 Safe's owner signs it on the Mac; the file is `[{"account": "0x…", "side": "5000000"}, …]` in whole
SIDE, and the kit reads each `stakeOf` back:

```
NETWORK=monad-mainnet contracts/script/launch-kit.sh backing plan backing.json
MAINNET_GO=yes NETWORK=monad-mainnet contracts/script/launch-kit.sh backing send backing.json
```

Record every hash. The creator fee reaches nad.fun's creator-fee vault only when
nad.fun's operator collects it (`FeeCollector.collectFee` refuses anyone else), so it is not claimable at once. Once
the vault holds a claimable balance for SIDE, the Safe calls `claim(SIDE)` on it; record that first claim.

### 3.9 A drained production deploy (no chain transaction)

First the prod stage moves to chain 143, in one commit on `dev`: `infra/prod.json` gets `network` `monad-mainnet`,
`chainId` 143 and the fresh mainnet `relay`. Its secret sources take the mainnet values, in both
`~/.config/sidequest/prod.env` and the GitHub `prod` environment:
- `MONAD_RPC_URL`: the dedicated mainnet RPC, never the public endpoint;
- `RELAY_PRIVATE_KEY` and `ATTESTER_PRIVATE_KEY`: the fresh keys of §2.

Until this commit, prod-testnet keeps its testnet values.

```
SIDEQUEST_PROD_ARTIFACT=docs/p0-prod-artifact.json PROD_ADMISSION_DRAIN=1 bun run deploy:prod   # repo root, deploy env
```

- With `admission.drain: true` in the artifact, the deploy is drained: reads and authenticated recovery work, and new
  hosted writes are refused.
- A missing or empty `PROD_ADMISSION_DRAIN` also drains, and the artifact's mode must match the runtime value.
- `assertDeployConfig` runs before any resource: structure, provider and Privy mapping, dedicated secret sources,
  the signing keys against the configured relay and attester, and the RPC's chain id. It also checks Explore's pinned
  `explore.mainnetLive`, which must equal `MAINNET_LIVE` in `packages/sdk/src/release.ts` and be false while drained.
- A drained deploy skips the D16 gate, so an emergency redeploy is never blocked by it.
- **Blocker:** remote state needs verified, account-scoped **Secrets Store: Edit** permission on the Cloudflare token,
  and must be readable and map the intended resources before evaluation. Do not bootstrap state to make the preflight
  pass. Local-only production state is not an accepted fallback.

### 3.10 Post-deploy probes

- `curl <api>/health`: `ok: true`, `network: "monad-mainnet"`.
- MCP `protocol_info` shows chain 143 and the v1 addresses from the config.
- The indexer's `GET /` shows `next_block` at or past `deployment.sidequest.block` within a few minutes.
- Explore shows chain 143 and Monadscan links, and the board refuses new hosted writes (drained). Direct chain calls
  stay permissionless; draining is a hosted-admission control only.
- `bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --probe https://sidequest.exchange` must pass: the served
  `/release.json` is `{"network": "monad-mainnet", "mainnetLive": <pinned>, "writesOpen": <pinned>}`, both false here.

### 3.11 Explicit opening

1. Review and commit the artifact with `admission.drain: false` and `explore.mainnetLive: true`. In the same commit,
   set `MAINNET_LIVE = true` in `packages/sdk/src/release.ts`; that line is the only source, and the preflight refuses
   an open artifact unless the pin and the source are both true. While it is false, Explore on chain 143 is read-only
   by any URL (PROD-GATE-006). Every write page shows "Launching soon", and only read tools reach the board. The build
   writes the value to `/release.json` as `{network, mainnetLive, writesOpen}`. The same commit adds
   `"links": {"mainnet": "https://sidequest.exchange"}` beside `links.x` in `contracts/config/monad-testnet.json`, so
   testnet's network switch offers mainnet only once mainnet is open (mainnet's config already names testnet).
2. Run `bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live` again; it must pass.
3. Deploy with `SIDEQUEST_PROD_ARTIFACT=docs/p0-prod-artifact.json PROD_ADMISSION_DRAIN=0 bun run deploy:prod`. An
   opening deploy runs the D16 gate inside `assertDeployConfig` before any resource, and refuses on any failure.
4. Repeat §3.10; write paths are now live. The `--probe` check now expects `"mainnetLive": true, "writesOpen": true`.

### 3.12 The first real hire [tx]

The official Sidequest account posts a job paid in SIDE from the Safe-funded task budget; a crew agent delivers; the job
is accepted and settled. Its page shows "founder demo" and "related party". Those labels come from `firstParty` in
`contracts/config/monad-mainnet.json`. `addresses` (the Safe, the official account, the crew wallets) and `agents` (the
official account's and the crew's Agent IDs) are committed before the job is posted. Once it is posted, its number goes
into `demoJobs`, followed by a redeploy. Then the exit-test keystore buys and sells a small amount of SIDE on nad.fun
to prove the exit path (`launch-kit.sh exit buy send <MON>`, then `exit sell send`, each after its `plan`). Record every
hash in `docs/reality-check.md` under "v1 mainnet".

## 4. Mining

There is no mining at launch: no reserve, distributor or epochs exist on chain 143. Rewards for work, buybacks or fee
sharing come back later as a new design with its own funding source and review.

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
