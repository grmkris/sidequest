# R7 launch rehearsal on a Monad mainnet fork — 12 October 2026

`RPC=https://rpc.monad.xyz bash contracts/script/rehearse-launch.sh` passed end to end at `c9e9180d` plus the
RehearseHire nonce fix in the same commit as this file. It ran on an anvil fork of chain 143, with anvil's public
development keys standing in for Kris's wallet, the Safe owners and the deployer. Nothing was sent to the real chain.
This is fork evidence, not a live deployment.

Earlier attempts that night:

- Two failed at step 6 because the rehearsal's two hires reused the creator's selection nonce, then the worker's
  budget authorization nonce. Both now use the job id.
- One failed in DeploySidequest when the fork timed out fetching an account from the public RPC. That was an
  infrastructure fault; the rerun passed.

## Steps

- Safe 0xd06Cca9088F1aaDF02bf801F7631D143D6D3F66E (1.4.1, owners 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0xBcd4042DE499D14e55001CcbB24a551F3b954096, threshold 1)
- SIDE 0x0735891528FF7CFd3eA9A73ff8dE754FA1873a57 on nad.fun: 1e9 supply, 18 decimals, permit, no burn; dev buy 50887926123381568926123381 wei (~5%), 40887926123381568926123380 to the Safe; the sink accepts SIDE
- deployed (19 transactions)
- promoted; D16 gate refuses with the four handovers pending
- the SDK reads the promoted record's reward tokens: USDC and SIDE, from knownTokens
- the Safe owns all four; D16 gate passes (reviewed Safe: canonical 1.4.1, pinned owners/threshold, no module, no guard; custody, core roles, verifier, relay above RELAY_FLOOR_MAINNET)
- D16 refuses a wrong pinned owner set and a Safe guard; passes again once cleared
- the Safe is 2-of-3; D16 refuses the stale threshold pin (["launch:safe threshold differs from the pinned one"]) and passes the new one
- hire settled in SIDE (net to worker 1800000000000000000000000)
- job 2 missed its deadline; slashed to the sink 1000000000000000000000000 SIDE wei
- bought 13457108372767935342669 SIDE wei for 1 MON and sold it back (MON before the sell: 6398912833479709881448)
- the creator-fee vault names the Safe as SIDE's recipient
- no chain-143 forge log outside broadcast/rehearsal-3695348-60b12215 and cache/rehearsal-3695348-60b12215 was touched

## Launch gas budget

Monad charges the gas limit. Hold twice the charged total in each sending wallet (runbook §2).

```text
LAUNCH BUDGET (Monad charges the gas limit; MON at 102 gwei now, and at forge's 203 gwei max fee)
step                                                                            txs    gas limit     gas used    MON@102    MON@203
1. Safe (1-of-3, SafeProxyFactory)                                                1       349492       344389     0.0356     0.0709
2. SIDE on nad.fun (create + 5% dev buy, Kris's wallet)                           1      1909454      1835641     0.1948     0.3876
2. dev buy to the Safe                                                            1        82918        82156     0.0085     0.0168
2. DeploySidequest (fresh core)                                                  19     23965192     18431160     2.4444     4.8649
3. PromoteSidequest (reads; writes config)                                        0            0            0     0.0000     0.0000
4. SafeAccept (4 execTransactions)                                                4       539441       411283     0.0550     0.1095
5. Safe to 2-of-3 (changeThreshold)                                               1        79603        77643     0.0081     0.0162
6. Two SIDE hires (fund, register, stake, publish, activate; one delivered and settled)   15      6636252      4194079     0.6769     1.3472
6. Missed delivery (rejectAfterDeliveryDeadline, settle)                          2      2398100       711911     0.2446     0.4868
7. Small buy and sell on nad.fun                                                  3      1123387      1100387     0.1146     0.2280
total                                                                            47     37083839     27188649     3.7826     7.5280
```

The deployer's share is DeploySidequest's 19 transactions: 23,965,192 gas limit, about 2.44 MON at 102 gwei. Kris's
wallet pays the nad.fun creation, the 5% dev buy (about 3,600 MON plus about 0.19 MON gas) and the transfer to the
Safe.

## Rerun for the 1-of-1 launch Safe (12 Oct, afternoon)

Kris chose a 1-of-1 Safe for launch, becoming 2-of-3 by 20 Oct (note 22). R7 now creates the Safe with one owner and
pins `owners: [owner], threshold: 1` for the gate. Step 5 rehearses the later upgrade in place: two
`addOwnerWithThreshold` calls through `execTransaction`, after which the gate refuses the stale 1-of-1 pin (owners and
threshold differ) and passes the 2-of-3 pin. `LAUNCH REHEARSAL PASSED` with 48 transactions, a 37,188,134 gas limit and
about 3.79 MON at 102 gwei. The two upgrade transactions (244,446 gas limit, about 0.025 MON) come after launch day.

In the launch itself, the creator, dev buy and exit test sign from `contracts/script/launch-kit.sh` on Kris's MacBook,
not from `0xB997…E471` (see `2026-10-12-launch-kit-dry-run.md`).
