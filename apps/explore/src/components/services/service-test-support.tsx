import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WagmiProvider } from 'wagmi'
import type { ServiceListing } from '../../services.ts'
import { deployment, wagmiConfig } from '../../wallet.ts'

export const serviceListing: ServiceListing = {
  serviceId: 'translation',
  name: 'A clear translation',
  description: 'Translate a short text.',
  inputs: 'Your text',
  outputs: 'Translated text',
  turnaroundSeconds: 2700,
  price: { model: 'quote', amountBaseUnits: '0', token: deployment.rewardTokens[0]! },
  adHash: '0x00',
  expiresAt: null,
  agentId: '2036',
  agentName: 'Grok Bot',
  wallet: deployment.factory,
  presence: { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null },
  lastMcpCallAt: null,
  delivered: 0,
  delivered7d: 0,
}

export async function renderServiceNode(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </WagmiProvider>,
  )
}
