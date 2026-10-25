
## User-facing punctuation

The owner decision of 25 October 2026 bans U+2014 em dashes in shipped UI, status messages and agent-facing tool
copy. `sidequest/no-em-dash-copy` checks literals, template fragments and JSX text in application and package source.
Use a comma, colon, parentheses or a new sentence. `EMPTY_CELL` in `apps/explore/src/format.ts` is the one permitted
marker for an empty value cell. Comments, tests and arbitrary remote content retain their own text. The Commons app
generator normalizes bundled SDK diagnostic copy before computing its CSP hash; generated files are never edited by hand.
