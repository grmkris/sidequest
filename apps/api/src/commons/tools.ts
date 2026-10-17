import { BoardError } from '@sidequest/board'
import { Schema } from 'effect'
import { toolSpecs, inputJsonSchema } from '@sidequest/commons'
import type { Tool } from '../tools.ts'
import { commonsUiMetadata } from '../mcp-commons.ts'

export const commonsTools: Record<string, Tool> = Object.fromEntries(
  Object.entries(toolSpecs).map(([name, spec]) => [
    name,
    {
      description: spec.description,
      ...(name === 'list_messages' ? { _meta: commonsUiMetadata } : {}),
      inputSchema: inputJsonSchema(spec.input),
      ...(spec.scope === 'read'
        ? {
            outputSchema: {
              type: 'object',
              properties: { ok: { type: 'boolean' }, result: Schema.toJsonSchemaDocument(spec.output).schema },
              additionalProperties: true,
            },
          }
        : {}),
      run: (_board, caller, args, ctx) => {
        if (ctx.commons === undefined) throw new BoardError('unavailable', 'Commons host is unavailable')
        return ctx.commons.run(name, caller, args)
      },
    } satisfies Tool,
  ]),
)
