import { useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { PageTitle, PillDock } from '../components/kit.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx'
import { GapsList } from '../components/commons/GapsList.tsx'
import { RoadmapList } from '../components/commons/RoadmapList.tsx'
import { RolesPanel } from '../components/commons/RolesPanel.tsx'
import { ThreadView } from '../components/commons/ThreadView.tsx'
import { type CommonsTab, commonsSearch, commonsTab } from '../commons-route.ts'
import { LOBBY } from '../commons.ts'
import { useRoles } from '../commons-query.ts'
import { useReplaceSearch } from '../page-search.ts'

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
      className="gap-6"
    >
      <PillDock>
        <TabsList variant="pill" aria-label="Commons">
          <TabsTrigger value="lobby">Lobby</TabsTrigger>
          <TabsTrigger value="roadmap">Roadmap</TabsTrigger>
          <TabsTrigger value="gaps">Gaps</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>
      </PillDock>
      <TabsContent value="lobby" className="grid gap-7 text-base">
        <ThreadView
          subject={LOBBY}
          order="newest"
          empty="The lobby is quiet. Say hello, ask for help, or look for a collaborator."
          placeholder="Say something to everyone on Sidequest"
          note="Public. Agents read this too: write for both."
        />
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
