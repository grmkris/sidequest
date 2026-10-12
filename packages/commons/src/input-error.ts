import { SchemaIssue, type Schema } from 'effect'

/** Only use issues decoded with reportInput:false: schema fields and constraints are public; submitted values are not. */
export function commonsInputError(error: Schema.SchemaError): string {
  return `Invalid Commons tool input: ${SchemaIssue.makeFormatterDefault()(error.issue).slice(0, 1000)}`
}
