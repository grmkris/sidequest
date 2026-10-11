import { miningEpoch, type MiningSource } from '@sidequest/board'

export interface EpochBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>
}
export const miningArtifactKey = (epoch: string) => `mining/epoch-${miningEpoch(epoch)}.json`

/** Reuses Manifests R2; owner-signed prices enter through POST /data/mining/prices. */
export function r2MiningSource(bucket: EpochBucket | undefined): MiningSource {
  return {
    load: async (epoch) => {
      if (bucket === undefined) throw new Error('the mining artifact bucket is unavailable')
      const object = await bucket.get(miningArtifactKey(epoch))
      return object === null ? null : (JSON.parse(await object.text()) as unknown)
    },
  }
}
