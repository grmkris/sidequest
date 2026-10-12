import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Schema } from 'effect'
import { type Hex, isHex } from 'viem'

const HexValue = Schema.declare<Hex>(isHex)
const RecordSchema = Schema.Struct({
  taskId: Schema.String,
  nonce: Schema.String,
  transaction: Schema.Struct({
    description: Schema.String,
    chainId: Schema.Number,
    to: HexValue,
    data: HexValue,
    value: Schema.Literal('0'),
    gas: Schema.optionalKey(Schema.String),
  }),
  raw: Schema.optionalKey(HexValue),
  hash: Schema.optionalKey(HexValue),
})
export type RulingSend = typeof RecordSchema.Type
export interface RulingJournal {
  load(taskId: string): Promise<RulingSend | undefined>
  save(record: RulingSend): Promise<void>
}
const MissingFile = Schema.Struct({ code: Schema.Literal('ENOENT') })

/** One file per chain/account/task, retained on the daemon's persistent volume. No key is stored. */
export function rulingJournal(directory: string, taskKey: (taskId: string) => string): RulingJournal {
  const path = (taskId: string) => `${directory}/${taskKey(taskId)}.json`
  return {
    async load(taskId) {
      try {
        return Schema.decodeUnknownSync(RecordSchema)(JSON.parse(await readFile(path(taskId), 'utf8')))
      } catch (error) {
        if (Schema.is(MissingFile)(error)) return undefined
        throw new Error('Ruling send journal could not be read', { cause: error })
      }
    },
    async save(record) {
      const target = path(record.taskId),
        temporary = `${target}.${process.pid}.tmp`
      await mkdir(dirname(target), { recursive: true })
      const file = await open(temporary, 'w', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, target)
      const parent = await open(dirname(target), 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    },
  }
}
