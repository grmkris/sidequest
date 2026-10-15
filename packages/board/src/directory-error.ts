export class DirectoryError extends Error {
  constructor(
    readonly code: 'invalid' | 'forbidden' | 'conflict' | 'chain' | 'not-found' | 'rate-limited',
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}
