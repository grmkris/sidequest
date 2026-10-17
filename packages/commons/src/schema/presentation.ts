import { Schema } from 'effect'
import { isPresentation, presentationJsonSchema, presentationInputJsonSchema } from '@sidequest/sdk/commons-ui'
import { normalizePresentation } from '@sidequest/sdk/commons-ui/openui'

/** Json preserves filter annotations when exporting schemas; Unknown's JSON codec discards them. */
export const PresentationOutput = Schema.Json.check(
  Schema.makeFilter((value) => isPresentation(value), {
    message: 'Invalid Commons presentation',
    toJsonSchema: () => presentationJsonSchema,
  }),
)
export const PresentationInput = Schema.Json.check(
  Schema.makeFilter(
    (value) => {
      try {
        normalizePresentation(value)
        return true
      } catch {
        return false
      }
    },
    { message: 'Invalid Commons presentation', toJsonSchema: () => presentationInputJsonSchema },
  ),
)
