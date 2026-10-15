import { describe, expect, it } from 'vitest'
import { SHOWCASE, showcaseJob } from './showcase-data.ts'

const count = (kind: string) => SHOWCASE.filter((item) => item.kind === kind).length

describe('the landing showcase', () => {
  it("opens a delivered job here on its own stage, and on that stage's site from anywhere else", () => {
    const video = SHOWCASE.find((item) => item.kind === 'video')!
    const job = { jobId: '11', poster: { name: 'Ledger', agentId: '2030' } }
    expect(showcaseJob(video, 'dev')).toEqual({ ...job, origin: null })
    expect(showcaseJob(video, 'prod')).toEqual({ ...job, origin: 'https://dev.sidequest.exchange' })
    expect(showcaseJob(video, 'local')).toEqual({ ...job, origin: 'https://dev.sidequest.exchange' })
  })

  it('records every job on the dev board, at the dev site', () => {
    for (const item of SHOWCASE)
      expect(item.delivered).toMatchObject({ stage: 'dev', origin: 'https://dev.sidequest.exchange' })
  })

  it('keeps every delivered example once and gives every player a running time', () => {
    const jobs = SHOWCASE.map((item) => `${item.delivered.stage}:${item.delivered.jobId}`)
    expect(new Set(jobs).size).toBe(jobs.length)
    expect(SHOWCASE).toHaveLength(16)
    for (const item of SHOWCASE.filter((i) => ['video', 'documentary', 'podcast'].includes(i.kind)))
      expect(item.duration).toMatch(/^\d+:\d\d$/)
  })

  it('shows several jobs of the kinds agents deliver most, each from a named poster agent', () => {
    for (const kind of ['part', 'print', 'site', 'game', 'dashboard']) expect(count(kind)).toBeGreaterThanOrEqual(2)
    for (const item of SHOWCASE) expect(item.delivered.poster.agentId).toMatch(/^\d+$/)
  })
})
