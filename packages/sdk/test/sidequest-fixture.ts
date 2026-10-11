/** Real v1 bytecode on a local Monad fork, with the deployed ERC-8004 registries. Never broadcasts remotely. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { monadTestnet } from 'viem/chains'
import { coreAbi, sideTokenAbi, sidequestHoldingAbi, stakeVaultAbi } from '../src/abi/index.ts'
import type { Ctx, Wallet } from '../src/actions.ts'
import { clocksFromConfig, deployment } from '../src/deployment.ts'
import testnetConfig from '../../../contracts/config/monad-testnet.json'
import { localTestPort } from './fork-port.ts'

const hasAnvil = (() => {
  try {
    execFileSync('anvil', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
export const forkEnabled = !!process.env.MONAD_TESTNET_RPC_URL && hasAnvil

function timeout(name: string, fallback: number) {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 600_000)
    throw new Error(`${name} must be 1..600000 milliseconds`)
  return Number(value)
}

/** Keep test hooks longer than readiness plus the fixture's account-funding requests. */
export const forkSetupTimeout = () =>
  Math.max(180_000, timeout('FORK_STARTUP_TIMEOUT_MS', 90_000) + 5 * timeout('FORK_RPC_TIMEOUT_MS', 30_000) + 90_000)

function artifact(name: string, source = name) {
  return JSON.parse(
    readFileSync(new URL(`../../../contracts/out/${source}.sol/${name}.json`, import.meta.url), 'utf8'),
  ) as { abi: Abi; bytecode: { object: Hex } }
}

export async function startSidequestFork() {
  const rpcTimeout = timeout('FORK_RPC_TIMEOUT_MS', 30_000)
  const startupTimeout = timeout('FORK_STARTUP_TIMEOUT_MS', 90_000)
  const port = await localTestPort()
  const url = `http://127.0.0.1:${port}`
  // The fixture funds its own random accounts. Default dev accounts cause needless genesis RPC reads;
  // throttle each fork as multiple suites and Forge share the provider's request budget.
  const node: ChildProcess = spawn(
    'anvil',
    [
      '--fork-url',
      process.env.MONAD_TESTNET_RPC_URL!,
      '--network',
      'monad',
      '--chain-id',
      '10143',
      '--accounts',
      '0',
      '--compute-units-per-second',
      '100',
      '--fork-retry-backoff',
      '1000',
      '--no-fork-node-info',
      '--port',
      String(port),
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = '',
    startError: Error | undefined
  node.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8192)
  })
  node.on('error', (error: Error) => {
    startError = error
  })
  const startupFailure = (reason: string) => {
    // Anvil can include its fork URL in RPC errors. Keep provider credentials out of gate logs.
    const detail = (startError?.message ?? stderr).replace(/https?:\/\/[^\s"'<>]+/g, '[redacted RPC URL]').trim()
    return new Error(
      `${reason} (exit ${node.exitCode ?? 'none'}, signal ${node.signalCode ?? 'none'})${detail ? `: ${detail}` : ''}`,
    )
  }
  let phase = 'readiness'
  const rpc = async (method: string, params: unknown[] = []) => {
    const signal = AbortSignal.timeout(rpcTimeout)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal,
      })
      const body = (await response.json()) as { result?: unknown; error?: { message: string } }
      if (body.error) throw new Error(body.error.message)
      return body.result
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError'))
        throw startupFailure(`Local anvil RPC timed out during ${phase} (${method}; ${rpcTimeout}ms)`)
      throw error
    }
  }
  try {
    let ready = false
    const readyBy = Date.now() + startupTimeout
    while (Date.now() < readyBy) {
      if (startError || node.exitCode !== null || node.signalCode !== null)
        throw startupFailure('Local anvil exited before readiness')
      if (await rpc('eth_chainId').catch(() => undefined)) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (!ready) throw startupFailure(`Local anvil readiness timed out (${startupTimeout}ms)`)
    const publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(url, { timeout: rpcTimeout }),
      pollingInterval: 10,
    })
    const wallet = () =>
      createWalletClient({
        account: privateKeyToAccount(generatePrivateKey()),
        chain: monadTestnet,
        transport: http(url, { timeout: rpcTimeout }),
      })
    const admin = wallet(),
      creator = wallet(),
      worker = wallet(),
      contributor = wallet(),
      arbitrator = wallet()
    phase = 'account funding'
    for (const account of [admin, creator, worker, contributor, arbitrator])
      await rpc('anvil_setBalance', [account.account.address, `0x${parseEther('1000').toString(16)}`])
    async function deploy(name: string, args: unknown[] = [], source = name) {
      phase = `deploy ${name}`
      const a = artifact(name, source)
      const hash = await admin.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Local ${name} deployment failed`)
      return receipt.contractAddress
    }
    const send = async (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
      phase = `configure ${functionName}`
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: await admin.writeContract({ address, abi, functionName, args }),
      })
      if (receipt.status !== 'success') throw new Error(`Local fixture ${functionName} failed`)
    }
    const d = deployment('monad-testnet')
    const implementation = await deploy('ERC8183WithAuthorization')
    const core = await deploy('ERC1967Proxy', [
      implementation,
      encodeFunctionData({
        abi: coreAbi,
        functionName: 'initialize',
        args: [admin.account.address, admin.account.address],
      }),
    ])
    // SIDE as the launcher creates it (no burn); the recipe deploys against an existing token and mints nothing.
    const factory = await deploy('LaunchToken', [admin.account.address])
    // Fresh fixtures use the recipe's clocks, including the three-day bond horizon.
    const clocks = clocksFromConfig(testnetConfig.sidequest.clocks, testnetConfig.chainId)
    const feeSchedule = await deploy('FeeSchedule', [
      {
        thresholds: [0n, parseEther('10000'), parseEther('100000'), parseEther('1000000')],
        bps: [3000, 1000, 300, 100],
        treasury: admin.account.address,
      },
      clocks,
    ])
    const vault = await deploy('StakeVault', [factory, clocks])
    const holding = await deploy('SidequestHolding', [
      core,
      vault,
      feeSchedule,
      d.identity,
      arbitrator.account.address,
      120,
      BigInt(testnetConfig.sidequest.minimumCreatorBond),
      BigInt(testnetConfig.sidequest.maxMinimumCreatorBond),
      testnetConfig.sidequest.unfilledForfeitBps,
      clocks,
    ])
    const evaluator = await deploy('SidequestEvaluator', [core, holding, d.reputation])
    await send(core, coreAbi, 'setHookWhitelist', [holding, true])
    await send(holding, sidequestHoldingAbi, 'setEvaluator', [evaluator])
    await send(vault, stakeVaultAbi, 'bootstrapHolding', [holding])
    for (const account of [creator, worker, contributor])
      await send(factory, sideTokenAbi, 'transfer', [account.account.address, parseEther('20000')])
    const stack = { kind: 'sidequest-v1' as const, factory, holding, evaluator, openTokens: true }
    const ctx: Ctx = {
      publicClient,
      stack,
      deployment: {
        ...d,
        core,
        factory,
        stacks: { main: stack },
        sidequest: {
          block: 0n,
          safe: admin.account.address,
          factory,
          vault,
          feeSchedule,
          clocks,
        },
      },
    }
    phase = 'ready'
    return {
      ctx,
      admin: admin as Wallet,
      creator: creator as Wallet,
      worker: worker as Wallet,
      contributor: contributor as Wallet,
      arbitrator: arbitrator as Wallet,
      url,
      rpc,
      deploy,
      send,
      close: () => {
        node.kill()
      },
    }
  } catch (error) {
    node.kill()
    throw error
  }
}
