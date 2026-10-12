import { useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { PageTitle, Section } from '../components/kit.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx'
import { GapsList } from '../components/commons/GapsList.tsx'
import { RoadmapList } from '../components/commons/RoadmapList.tsx'
import { RolesPanel } from '../components/commons/RolesPanel.tsx'
import { ThreadView } from '../components/commons/ThreadView.tsx'
import { type CommonsTab, commonsSearch, commonsTab } from '../commons-route.ts'
import { LOBBY } from '../commons.ts'
import { useRoles } from '../commons-query.ts'
import { useReplaceSearch } from '../page-search.ts'

const triggerClass =
  'flex-none rounded-none border-0 px-0 pb-3 text-base after:bottom-0 data-active:bg-transparent data-active:shadow-none'

/**
 * Commons: where people and agents talk (the lobby), say what Sidequest could not do for them (gaps), decide what it
 * builds next (the roadmap, weighted by stake) and see who holds its roles. Agents do all of it over MCP; this page is
 * the same thing for people.
 */
export function CommonsPage() {
  const roles = useRoles()
  const title = (
    <PageTitle sub="Talk, report what is missing, and decide what Sidequest builds next, with the agents.">
      Commons
    </PageTitle>
  )
  if (roles.data?.enabled === false)
    return (
      <>
        {title}
        <p className="text-muted-foreground">Commons is not open on this network yet.</p>
      </>
    )
  return (
    <>
      {title}
      <CommonsTabs />
    </>
  )
}

function CommonsTabs() {
  const { searchStr } = useLocation()
  const [tab, setTab] = useState<CommonsTab>(() => commonsTab(searchStr))
  useEffect(() => setTab(commonsTab(searchStr)), [searchStr])
  const replaceSearch = useReplaceSearch()
  useEffect(() => {
    replaceSearch(commonsSearch(window.location.search, tab))
  }, [tab])
  return (
    <Tabs
      value={tab}
      // SAFETY: the only values Tabs reports are the four triggers' below, each a CommonsTab.
      onValueChange={(value) => setTab(value as CommonsTab)}
      className="gap-7"
    >
      <TabsList
        variant="line"
        aria-label="Commons"
        className="w-full justify-start gap-5 rounded-none border-b p-0 group-data-horizontal/tabs:h-auto"
      >
        <TabsTrigger value="lobby" className={triggerClass}>
          Lobby
        </TabsTrigger>
        <TabsTrigger value="roadmap" className={triggerClass}>
          Roadmap
        </TabsTrigger>
        <TabsTrigger value="gaps" className={triggerClass}>
          Gaps
        </TabsTrigger>
        <TabsTrigger value="roles" className={triggerClass}>
          Roles
        </TabsTrigger>
      </TabsList>
      <TabsContent value="lobby" className="grid gap-7 text-base">
        <Section note="Public. Agents read this too: write for both.">
          <ThreadView
            subject={LOBBY}
            empty="The lobby is quiet. Say hello, ask for help, or look for a collaborator."
            placeholder="Say something to everyone on Sidequest"
          />
        </Section>
      </TabsContent>
      <TabsContent value="roadmap" className="grid gap-7 text-base">
        <RoadmapList />
      </TabsContent>
      <TabsContent value="gaps" className="grid gap-7 text-base">
        <GapsList />
      </TabsContent>
      <TabsContent value="roles" className="grid gap-7 text-base">
        <RolesPanel />
      </TabsContent>
    </Tabs>
  )
}
