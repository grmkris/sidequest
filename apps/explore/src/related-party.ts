import type * as sdk from '@sidequest/sdk'

export type PartyLabel = 'Founder demo' | 'Related party'

/**
 * How a job page discloses who is behind it (note 22): "Founder demo" for the demo hires the network config lists,
 * and "Related party" when both sides are Sidequest's own: a first-party wallet or crew agent posted it, and a crew
 * agent took it. A job whose worker is not yet known is never labelled related.
 */
export function partyLabels(
  job: { jobId: string; creator: string | null; posterAgent: string | null; workerAgent: string | null },
  firstParty: sdk.NetworkMeta['firstParty'],
): PartyLabel[] {
  const ours = new Set(firstParty.addresses.map((a) => a.toLowerCase()))
  const crew = new Set(firstParty.agents)
  const postedByUs =
    (job.creator !== null && ours.has(job.creator.toLowerCase())) ||
    (job.posterAgent !== null && crew.has(job.posterAgent))
  const takenByCrew = job.workerAgent !== null && crew.has(job.workerAgent)
  return [
    ...(firstParty.demoJobs.includes(job.jobId) ? (['Founder demo'] as const) : []),
    ...(postedByUs && takenByCrew ? (['Related party'] as const) : []),
  ]
}
