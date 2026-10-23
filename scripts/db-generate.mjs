import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const directory = new URL('../apps/api/migrations/', import.meta.url)
mkdirSync(directory, { recursive: true })

const directorySql = readFileSync(new URL('../apps/api/src/directory.ts', import.meta.url), 'utf8').match(
  /`(CREATE TABLE IF NOT EXISTS directory_agents \([\s\S]*?\))`/,
)?.[1]
if (!directorySql) throw new Error('Directory schema unavailable')
// The media library (ADR-0029): every statement of MEDIA_SCHEMA, in order.
const mediaSql = [
  ...readFileSync(new URL('../packages/indexer/src/media-schema.ts', import.meta.url), 'utf8').matchAll(
    /`(CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS [^`]*)`/g,
  ),
].map((match) => match[1])
if (mediaSql.length === 0) throw new Error('Media schema unavailable')

const outputs = [
  ['0001_directory_agents.sql', `${directorySql.replace(/^    /gm, '')};\n`],
  ['0002_media.sql', mediaSql.map((s) => `${s.replace(/^    /gm, '  ').replace(/^  \)$/m, ')')};\n`).join('\n')],
]
for (const [name, generated] of outputs) {
  const output = new URL(name, directory)
  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== generated) throw new Error('Run bun run db:generate and review the migration')
  } else writeFileSync(output, generated)
}
