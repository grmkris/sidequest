import { Button } from '../components/ui/button.tsx'
import { Item, ItemGroup, ItemDescription, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { CopyButton, PageTitle, Section } from '../components/kit.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { type AccountTab, accountSearch, accountTab } from '../account-route.ts'
import { Count } from '../components/AccountLink.tsx'
import { WalletCard } from '../components/Fund.tsx'
import { SetupPill } from '../components/onboarding/Onboarding.tsx'
import { InstallHint } from '../components/InstallHint.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { BackingManager } from '../components/BackingManager.tsx'
import { ResumeOffer } from '../components/post/Resume.tsx'
import { LaunchNotice } from '../components/LaunchGate.tsx'
import { CollectSection } from './Collect.tsx'
import { MyActivity } from '../components/MyActivity.tsx'
import { TelegramSection } from './Telegram.tsx'

import { Monogram, useAuth, useSignOut } from '../components/Wallet.tsx'
import { useCollectActions } from '../collect.ts'
import { writesOpen } from '../wallet.ts'
import { useSafeOwner } from './Admin.tsx'
import { useReplaceSearch } from '../page-search.ts'

/**
 * The signed-in person's account, in four tabs: Wallet (balances, test tokens, buying, what is ready to collect),
 * Backing (their SIDE behind wallets and agents), Notifications (Telegram) and Settings. What waits on them in jobs is
 * under Jobs › Mine; their agents are under Agents.
 */
export function AccountPage() {
  const auth = useAuth()
  const { searchStr } = useLocation()
  const resume = new URLSearchParams(searchStr).get('resume')
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle>Account</PageTitle>

        <section className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover">
          <h2 className="text-xl leading-tight font-bold tracking-tight">Sign in to post and approve work</h2>
          <p className="leading-relaxed text-muted-foreground">
            Use your email or Google. Sidequest makes you a wallet, so no browser extension is needed; you sign once to
            prove it is you.
          </p>
          <div>
            <PrivyLogin />
          </div>
        </section>

        <InstallHint />
      </>
    )
  }
  return (
    <>
      <PageTitle sub={<Identity address={auth.address} />}>Account</PageTitle>

      <SetupPill address={auth.address} className="justify-self-start" />

      <InstallHint />

      {resume !== null && resume !== '' && <ResumeOffer key={resume} taskId={resume} auth={auth} />}

      <AccountTabs address={auth.address} />
    </>
  )
}

/** Who is signed in, under the title on every tab: the wallet's mark and short address, copyable. */
function Identity({ address }: { address: Address }) {
  return (
    <>
      <Monogram seed={address} />
      <span className="font-mono text-ui">
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
      <CopyButton value={address} label="Copy address" />
    </>
  )
}

const triggerClass = 'flex-none px-0 min-h-9 pointer-coarse:min-h-11 group-data-horizontal/tabs:after:bottom-[-1px]'

/**
 * The account's tabs, kept in the URL (`?tab=`). A link to one of the page's old section anchors (`/account#backing`,
 * from the wallet's balances and elsewhere) opens that tab, also when it comes while the page is already open.
 */
function AccountTabs({ address }: { address: Address }) {
  const auth = useAuth()
  const { searchStr, hash, state } = useLocation()
  const [tab, setTab] = useState<AccountTab>(() => accountTab(searchStr, hash))
  useEffect(() => setTab(accountTab(searchStr, hash)), [searchStr, hash, state])
  const replaceSearch = useReplaceSearch()
  useEffect(() => {
    replaceSearch(accountSearch(window.location.search, tab))
  }, [tab])
  // Nothing is counted when unknown.
  const collect = useCollectActions(auth.address, auth.signedIn).data?.length ?? 0
  return (
    <Tabs
      value={tab}
      // SAFETY: the only values Tabs reports are the four triggers' below, each an AccountTab.
      onValueChange={(value) => setTab(value as AccountTab)}
      className="gap-7"
    >
      <TabsList
        variant="line"
        aria-label="Account"
        className="w-full justify-start gap-5 rounded-none border-b p-0 group-data-horizontal/tabs:h-auto"
      >
        <TabsTrigger value="wallet" className={triggerClass}>
          Wallet
          {collect > 0 && <Count n={collect} kind="collect" />}
        </TabsTrigger>
        <TabsTrigger value="backing" className={triggerClass}>
          Backing
        </TabsTrigger>
        <TabsTrigger value="notifications" className={triggerClass}>
          Notifications
        </TabsTrigger>
        <TabsTrigger value="settings" className={triggerClass}>
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="wallet" className="grid gap-7 text-base">
        <WalletCard address={address} />
        <CollectSection />
      </TabsContent>
      {/* Kept mounted, so switching tabs never interrupts a backing transaction waiting in the wallet. */}
      <TabsContent value="backing" keepMounted className="grid gap-7 text-base">
        <Section id="backing">
          {writesOpen ? <BackingManager owner={address} scope={{ kind: 'account' }} /> : <LaunchNotice />}
        </Section>
      </TabsContent>
      <TabsContent value="notifications" className="grid gap-7 text-base">
        <TelegramSection />
        <MyActivity />
      </TabsContent>
      <TabsContent value="settings" className="grid gap-7 text-base">
        <AccountSettings />
      </TabsContent>
    </Tabs>
  )
}

/** Account settings: gas sponsorship, the Safe owner's admin, the docs, the other network, and signing out. */
function AccountSettings() {
  const auth = useAuth()
  const signOut = useSignOut(auth)
  const owner = useSafeOwner(auth.address)
  return (
    <>
      <Section title="Settings">
        <ItemGroup>
          <Item render={<Link to="/sponsorship" />}>
            <ItemContent className="flex-1">
              Gas payments
              <ItemDescription className="block text-xs text-muted-foreground">
                You pay a fraction of a cent in USDC, or use MON
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          {owner === true && (
            <Item render={<Link to="/admin" />}>
              <ItemContent className="flex-1">
                Admin
                <ItemDescription className="block text-xs text-muted-foreground">
                  You own the Safe that owns Sidequest
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          )}
          {/* The docs are served beside the app, not routed in it, so this is a plain link. */}
          <Item render={<a href="/docs" aria-label="Docs" />}>
            <ItemContent className="flex-1">
              Docs
              <ItemDescription className="block text-xs text-muted-foreground">
                How Sidequest works, for people and their agents
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </ItemGroup>
      </Section>

      <Button variant="destructive" size="lg" onClick={signOut}>
        Sign out
      </Button>
    </>
  )
}
