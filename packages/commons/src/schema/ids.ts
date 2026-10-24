import { Schema, SchemaGetter } from 'effect'

export const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((s) => s.toLowerCase()),
    encode: SchemaGetter.transform((s) => s.toLowerCase()),
  }),
)
export type Address = typeof Address.Type
export const Subject = Schema.String.check(
  Schema.isPattern(/^(?:lobby|job:[a-z0-9-]{3,32}:[A-Za-z0-9_-]{1,64}|roadmap:[1-9][0-9]{0,14})$/u),
)
export type Subject = typeof Subject.Type
export const Cursor = Schema.String.check(Schema.isPattern(/^c:[0-9]{1,15}$/u))
/** A message cursor as a page returns it (`c:94`), or the bare message id it names (`94`), which clients often keep. */
export const MessageCursor = Schema.Union([
  Cursor,
  Schema.String.check(Schema.isPattern(/^[0-9]{1,15}$/u)).pipe(
    Schema.decodeTo(Cursor, {
      decode: SchemaGetter.transform((id) => `c:${id}`),
      encode: SchemaGetter.transform((cursor) => cursor.slice(2)),
    }),
  ),
])
export const WeiString = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u))
export const Integer = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const IntegerString = Schema.String.check(Schema.isPattern(/^[0-9]+$/u)).pipe(
  Schema.decodeTo(Integer, {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transform(String),
  }),
)
export const NumericInteger = Schema.Union([Integer, IntegerString])
export const ItemId = NumericInteger.check(Schema.isGreaterThanOrEqualTo(1))
export const GapId = NumericInteger.check(Schema.isGreaterThanOrEqualTo(1))
export const Limit = NumericInteger.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
export const OutputId = Integer.check(Schema.isGreaterThanOrEqualTo(1))
export const text = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isBetweenCodePoints(minimum, maximum))
export const ToolName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{1,63}$/u))
