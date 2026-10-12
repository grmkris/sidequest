# Launch kit dry run, 12 October 2026

`contracts/script/launch-kit.sh` signs the launch steps held on Kris's MacBook (note 22, 12 Oct): the 1-of-1 Safe,
SIDE through nad.fun's API and V2 router, the dev-buy move, SafeAccept, the backing batch and the exit test. This is
the agent's dry run from netcup with throwaway keystores (`KIT_AGENT_DRY_RUN=testnet-only`, marked so a mainnet send
refuses them), funded with 0.9 testnet MON from the dev Safe owner. It proves the kit on testnet only; nothing here is
a mainnet claim.

## Live on Monad testnet (10143)

| Step | Result | Transaction |
| :-- | :-- | :-- |
| `safe send` | Safe v1.4.1 `0xEb1cCeA7700cf99B9fFE16559AFd9ce6769D9F8d`: one owner, threshold 1, no module | `0x9ede7cb43f6e51e85b07b921d4fca4d448999cf581e17072f6217ab5be2cde44` |
| `token send` | "Sidequest Test" (SQTEST) `0x87541a7C6c58Bb065E0184ED0E5C1f1469A17777` with a 0.05 MON dev buy; 18 decimals, 1e9 supply; the creator-fee vault's `getCreator` is the Safe; nad.fun's API lists it with the image, website, X and Telegram links | `0x2f186e6fe900742abebfa5511423f5abf5c43cf14ce71ae9e6d1a9b8fdf1b9de` |
| `move send` | the creator's 742.39 SQTEST to the Safe | `0x687a1ab5bc28bdf891a608790ab520b9c97d940bb6e4980bd6b8d4fe6d7fae5d` |
| `exit buy send 0.05` | the exit-test wallet bought 742.39 SQTEST | `0xeb47cd30262d4bfd088fbe86f562d80fa98b7c30ea1b0a5b58ea58b692978982` |
| `exit sell send` | approve, then `sellToNative` for 0.048 MON | `0xadb58c47…72fdc`, `0x540d8e3c…6df` |

The token plan uploaded the logo and `docs/brand/nadfun-token.json` to `dev-api.nadapp.net`, read the stored metadata
back, got a V2 salt, and checked the address (ending 7777) with `cast create2` before simulating.

## On a testnet fork

- `backing send` from the 1-of-1 Safe: one MultiSendCallOnly batch of `approve` plus two `delegateFor` calls (1 and
  2.5 testnet SIDE); `stakeOf` read back 1e18 and 2.5e18.
- `accept plan` ran SafeAccept.s.sol with the owner as sender. It refused, as it should, because the testnet config's
  promoted Safe is the G1e Safe; the kit now refuses first when the config's Safe isn't the kit's Safe.

## Not covered

- `accept send` against fresh contracts: R7 rehearses SafeAccept on a mainnet fork.
- The macOS Keychain path: `setup`, `copy-password` and the approval prompt run only on the Mac. Kris's own run on
  testnet is the check.
