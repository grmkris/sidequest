# R7 launch rehearsal on a Monad mainnet fork — 13 October 2026

`RPC=https://rpc.monad.xyz heavy bash contracts/script/rehearse-launch.sh` printed `LAUNCH REHEARSAL PASSED` at
`2bfdc17b` (merged to dev as `9e040527`, same tree). It ran on an anvil fork of chain 143, with anvil's public
development keys standing in for Kris's wallet, the Safe owners and the deployer. Nothing was sent to the real chain.
This is fork evidence, not a live deployment.

This rerun covers the changes made after the 12 October rehearsal:

- slashed SIDE goes to a Safe-set `slashRecipient` instead of `0x…dEaD` (ADR-0024, `aa/slash`);
- the pre-launch contract review's launch-kit fixes: chain binding, mainnet fee and slash sinks pinned to the Safe,
  core health rechecked on every promotion, Safe acceptance plans, journaled kit sends;
- the launch review's mainnet-stage fixes: a relay-free mainnet. The D16 gate now checks the arbitrator's MON
  (`ARBITER_LAUNCH_MON`) and the account-abstraction bytecode instead of a relay floor (`aa/mainnet`).

An earlier run on `fa9ced4f` (slash and launch-kit fixes only) also passed end to end.

## Steps

- Safe 0x654542047FA19f06f8AC5C01CbadA960ef77153E (1.4.1, owner 0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
  threshold 1)
- SIDE 0x5f16661D1BAEa71F0722278b8516F42CaAD962Af on nad.fun: 1e9 supply, 18 decimals, permit, no burn; dev buy
  50887926123381568926123381 wei (~5%), 40887926123381568926123380 to the Safe; the slash recipient accepts SIDE
- deployed (19 transactions)
- promoted; D16 gate refuses with the four handovers pending
- R7 AA probe: EntryPoint, paymaster and USDC bytecode on the local fork; Pimlico readiness injected, no provider call
- the SDK reads the promoted record's reward tokens: USDC and SIDE, from knownTokens
- the Safe owns all four; D16 gate passes (reviewed Safe: canonical 1.4.1, pinned owners/threshold, no module, no
  guard; custody, core roles, verifier, arbitrator at ARBITER_LAUNCH_MON; AA bytecode on the local fork, Pimlico
  readiness injected)
- D16 refuses a wrong pinned owner set and a Safe guard; passes again once cleared
- the Safe went 1-of-1 to 2-of-3 in place; D16 refuses the stale pin (owners and threshold differ) and passes the
  new one
- hire settled in SIDE (net to worker 1800000000000000000000000)
- job 2 missed its deadline; slashed to the recipient (the Safe) 1000000000000000000000000 SIDE wei
- bought 13457108372767935342669 SIDE wei for 1 MON and sold it back
- the creator-fee vault names the Safe as SIDE's recipient
- no chain-143 forge log outside the rehearsal's own broadcast and cache directories was touched

## Launch gas budget

Monad charges the gas limit. Hold twice the charged total in each sending wallet (runbook §2).

```text
LAUNCH BUDGET (Monad charges the gas limit; MON at 102 gwei now, and at forge's 203 gwei max fee)
step                                                                            txs    gas limit     gas used    MON@102    MON@203
1. Safe (1-of-1, SafeProxyFactory)                                                1       288928       285681     0.0295     0.0587
2. SIDE on nad.fun (create + 5% dev buy, Kris's wallet)                           1      1909465      1835651     0.1948     0.3876
2. dev buy to the Safe                                                            1        65648        65156     0.0067     0.0133
2. DeploySidequest (fresh core)                                                  19     24026954     18478669     2.4507     4.8775
3. PromoteSidequest (reads; writes config)                                        0            0            0     0.0000     0.0000
4. SafeAccept (4 execTransactions)                                                4       539469       411305     0.0550     0.1095
5. after launch, by 20 Oct: Safe 1-of-1 to 2-of-3 (addOwnerWithThreshold x2)      2       244446       238052     0.0249     0.0496
6. Two SIDE hires (fund, register, stake, publish, activate; one delivered and settled)   15      6636698      4194421     0.6769     1.3472
6. Missed delivery (rejectAfterDeliveryDeadline, settle)                          2      2398295       712061     0.2446     0.4869
7. Small buy and sell on nad.fun                                                  3      1123387      1100387     0.1146     0.2280
total                                                                            48     37233290     27321383     3.7978     7.5584
```

## Not covered here

The real chain-143 sends from Kris's MacBook keystores. The launch kit's own interruption paths, which are covered
by offline tests with a stubbed `cast`. Pimlico on 143, which this rehearsal injects as ready. The mainnet Privy
policy, AgentSweep on 143, the mainnet arbiter's live ruling, and any hosted or browser user op on 143.
