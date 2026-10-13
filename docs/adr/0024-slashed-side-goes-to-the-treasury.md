# ADR-0024: Slashed SIDE goes to the treasury

Status: Accepted
Date: 2026-10-13

## Context

SIDE has a fixed supply and no burn function. The previous vault sent slashed reservations to the dead address,
removing them from circulation. Kris decided before the mainnet deployment to retain that SIDE for the treasury;
stakers will decide later what it funds.

## Decision

New `StakeVault` deployments take a nonzero `slashRecipient` constructor argument. Mainnet launches with the treasury
Safe as recipient. Only the vault owner, the Safe after handover, can change it with `setSlashRecipient`; zero and the
vault itself refuse. Sending slashed SIDE back to the vault would leave it outside `totalAssets`.

Every change emits `SlashRecipientSet(previous, recipient)`. There is no timelock: changing where a penalty goes
never changes the backer's loss, the slash conditions, or the reserved amount. `Slashed`, Holding's `burnBond` and
`*BondBurned` ABI names stay compatible.

## Consequences

The Safe gains the power to route future slashes, in addition to spending SIDE it already holds. Slashed tokens stay
in the supply and remain spendable by their recipient. Governance by stakers is intent, not an implemented mechanism.

Shares, queued backing, reservations and loss calculations stay unchanged. The recipe, verifier, promotion records,
R7 and launch kit check the recipient. Existing testnet vaults keep their dead-address behavior; SDK receipt proof
also accepts older zero-address burns. Only dated live receipts establish deployed behavior.
