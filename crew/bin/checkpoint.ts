#!/usr/bin/env bun
/**
 * A member's inbox checkpoint, read and written from its run (crew/shared/COMMON.md); in its container it runs as the
 * bundle `bun --no-install /crew/src/crew/bin/checkpoint.js`.
 *
 *   checkpoint read <path>                       the cursor to resume from, or resync: true when no copy is usable
 *   checkpoint commit <path> '<checkpoint JSON>'  after processing a batch: { cursor, processedAt?, modelNote? }
 */
import { Schema } from 'effect'
import { Checkpoint, readCheckpoint, saveCheckpoint } from './inbox-state.ts'

const USAGE = 'usage: checkpoint read|commit <path> [checkpoint JSON]'
const [command, path, payload] = Bun.argv.slice(2)
if (path === undefined) throw new Error(USAGE)
if (command === 'read') {
  const { checkpoint, resync } = readCheckpoint(path)
  console.log(JSON.stringify({ ...(resync ? {} : { cursor: checkpoint?.cursor }), resync, lastValid: checkpoint }))
} else if (command === 'commit' && payload !== undefined) {
  saveCheckpoint(path, Schema.decodeUnknownSync(Checkpoint)(JSON.parse(payload)))
} else throw new Error(USAGE)
