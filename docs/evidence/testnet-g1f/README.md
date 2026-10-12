# G1f testnet generation: SIDE from nad.fun's testnet launcher, 12 October 2026

Kris decided on 12 Oct to move dev and prod-testnet onto a SIDE launched through nad.fun's **testnet** launcher, so
testnet replicates the mainnet launch. G1f was set up with the same tools the mainnet launch uses: the signing kit
(`contracts/script/launch-kit.sh`, here with agent-made testnet-only keystores under `.sidequest/kit-testnet`) and
the testnet generation wrapper (`scripts/sidequest/contracts.mjs`). G1e is archived at
`contracts/config/archive/pre-g1f-monad-testnet.json`; its jobs and backing stay on chain and aren't refunded (test
tokens; Kris's call). Testnet MON limited the dev buy to 9.5 MON (0.01% of supply, about 141k SIDE) rather than 5%.

| Step | Result | Transaction |
| :-- | :-- | :-- |
| Fund the kit's creator (10 MON) and owner (0.6 MON) | from the dev relay and the testnet Safe owner | `0x1ba5b80c…a6f29d93`, `0xcf8f6178…f87dd1e6` |
| `safe send` | 1-of-1 Safe v1.4.1 `0x78d5A4DB279C6850a07278A5A8EE76296740E438`, owner `0x93ed762bD245c5522A6A411B0415d7bc420eF8f6` | `0xda39de21ea7ed298fed238073c83358649028abe720029936e3a96ac78ad16db` |
| `token send` (nad.fun testnet API metadata and V2 salt) | Sidequest (SIDE) `0xF4c211303e00716819E08E735Be2136329557777`, 9.5 MON dev buy for 141,036.92 SIDE; creator-fee vault pays the Safe; listed on nad.fun's testnet API | `0x34d1d2b138644d6f49e8202a7d32762cc02b7e2c76a6a574a41f3098fc1a232d` |
| `move send` | the dev buy to the Safe | `0x3a9a622c69ea4d8e232e034f8d47314e816e4e9fb772b2c478a048ea64c23273` |
| Fund the deployer (2.6 MON) | from the dev relay | `0x3d050cbf0d03cd5bcc1bc87a423479025610859665fd0e961f1f60723b3297fe` |
| `contracts.mjs deploy --generation g1f` | the recipe against nad.fun SIDE (the testnet config now carries a `nadfun` block, so the clone check runs as on mainnet); Sidequest block 70431058, core `0xE5E912F99551B0520C172DEC7296816Bb103f573` | forge log `.sidequest/contracts-g1f-deploy.log` |
| `contracts.mjs promote --generation g1f` | deployment record written (Holding `0x6E35f8faB65b5294094A260C952B5d1efCA6c348`, Evaluator `0xD8041Ed6FEAbF9e31F1bAA99A95eb09E618c9d75`, StakeVault `0x795243DF7f2e84b6EaCF69811F20B4d36980c366`, FeeSchedule `0x3d6d98d3c4ff2aB9102797DA7d3d3c0eD1188498`) | no transaction |
| `launch-kit.sh accept send` | SafeAccept.s.sol from the kit's owner: 4 acceptances; `owner() == Safe` on all four | forge broadcast |
| Faucet | TestnetFaucet `0x6b8AA596f30d765E4F3C6ec2B1e994F19098df33`, 200 SIDE plus 1,000 of each payment token per claim | `0x156be29bf3b6f0850d713a1f25c9fc3813b36587cd3deb71271d77309f326089` |
| `launch-kit.sh fund send <faucet> 100000` | the Safe funds the faucet with 100,000 SIDE; it keeps 41,036.92 | `0xdc55d2529b287c26710b00e19c849fb41831720ffe3b298612968127abef46e6` |

**Config changes.** `sidequest.safe`, `schedule.treasury` and `sidequest.token` name the G1f Safe and SIDE. The
Uniswap `liquidity` block is gone, so testnet has no market of ours; Explore's "Get SIDE" opens testnet.nad.fun, as on
mainnet. The SDK's G1e market tests now read the archived config.

**Still to do after the dev deploy:** the Privy routine-policy cutover for G1f's Holding and core; re-pinning the
role containers and the crew (release session); prod-testnet's release on Kris's go; and a live recheck. Every hosted
agent re-backs and its operator re-approves on G1f.
