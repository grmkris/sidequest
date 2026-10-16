# Commons reading and writing pass

Implementation: `e469c8b6`. Scope: Commons posts (including job and roadmap threads), roadmap problem/proposal bodies,
gap report detail, and the message/proposal editors. This is a rendering and authoring change; Markdown checkboxes
display the author's text and do not execute, assign, or persist workflow steps.

## Design choices

Keep Sidequest's existing token system: paper `#FAFAF9`, white `#FFFFFF`, ink approximately `#0D1015`, evergreen
approximately `#164536`, muted text approximately `#60646A`, and structural grey approximately `#DADBD8`.
The existing OKLCH tokens in `styles.css` remain authoritative, including dark-mode equivalents.
Geist stays the reading/UI face; monospace is reserved for actual code. Body text is 1rem with 1.7 leading and a
72ch maximum measure inside the existing route width. Headings use weight and spacing, rather than decorative labels.

The layout follows the subject: an authored document, followed by discussion and a place to respond. Left alignment
helps scan steps and compare replies. Only replies indent; borders identify relationships or field boundaries.

```text
author / role                                      time
document heading
paragraph, link, quote, code or table
  [x] agreed step
  [ ] next step
Reply
    reply author / time
    reply body

Message                         character count
[ Write | Preview ]
draft or its rendered preview
formatting examples                         Post
```

The initial idea of a separate document-width container was removed after the repository's design-contract test:
the shell owns page width. Reading measure belongs to the content itself. Extra animation, a new typeface and
workflow-board chrome would distract from the requested reading improvement, so this pass adds none of them.

## Interface review

Mode: **full**. React 19, Tailwind 4, existing Base UI/shadcn components and semantic OKLCH tokens.
The review covers the surfaces above, not the rest of Explore. Browser evidence uses the local changed UI and
anonymous public dev reads, with unsent drafts. Sign-in is disabled in the final local preview.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | `Markdown.tsx`, scoped styles, real posts/reports, draft preview screenshots | Headings, prose, code, lists and wrapping corrected |
| Surfaces | Message rows, reply context, editor, table/code overflow at 1440px and 390px | Grouping and overflow corrected |
| Animations | Existing tabs/button transitions; reduced-motion browser contexts | No new motion; existing feedback reused; normal-speed slow-motion review not performed |
| Icons | Existing Reply/X icons and native read-only checkbox states | Existing icon family retained; larger reply targets |
| Performance | Stable renderer mappings/plugins; shared preview renderer; no syntax highlighter or remote image loading | Source reviewed; no load-performance benchmark claimed |

All findings below were addressed in the implementation.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `apps/explore/src/components/commons/MessageRow.tsx:55`, `GapReports.tsx:53`, `apps/explore/src/routes/RoadmapItem.tsx:57` | Markdown displayed as punctuation in plain paragraphs | Shared GFM renderer for complete bodies | Typography and hierarchy: steps, emphasis and links are readable |
| MEDIUM | `apps/explore/src/components/commons/Markdown.tsx:5`, `apps/explore/src/styles.css:11` | No document-level structure or task-list presentation | Bounded headings, nested lists, disabled checkboxes, quotes, inline/fenced code, tables | Familiarity: plans can be written as reviewable steps |
| MEDIUM | `apps/explore/src/components/commons/MarkdownEditor.tsx:18`, `Composer.tsx:61`, `ProposeForm.tsx:71` | Only raw textareas | Write/Preview with the same renderer, Markdown examples and an informative empty preview | Agency: inspect formatting before posting without losing the draft |
| MEDIUM | `apps/explore/src/components/commons/MarkdownEditor.tsx:31`, `ProposeForm.tsx:25` | Proposal fields silently stopped accepting more text | Visible limits, inline over-limit guidance and disabled submission | Feedback: explain why a draft cannot be submitted |
| MEDIUM | `apps/explore/src/components/commons/Composer.tsx:34`, `ProposeForm.tsx:31` | Unhandled rejected mutation promises; fields editable during submission | Mutation error state owns failures; drafts clear only on success; pending fields disabled | Predictability: failures preserve work and pending writes cannot erase a newer draft |
| MEDIUM | `apps/explore/src/components/commons/Composer.tsx:82`, `MarkdownEditor.tsx:32` | Reply showed only an address and left focus on the post | Quoted excerpt, source link, return to Write and draft focus | Grouping: the response has visible context |
| MEDIUM | `apps/explore/src/components/commons/Markdown.tsx:38`, `MarkdownEditor.tsx:36`, `Composer.tsx:55`, `ProposeForm.tsx:46`, `GapReports.tsx:56` | New wide Markdown could size the editor beyond the phone viewport | Shrinkable fields and explicit grid columns; keyboard-focusable local overflow regions | Flexibility: long URLs, tables and code stay inside the screen |
| LOW | `apps/explore/src/components/commons/MessageRow.tsx:41`, `ThreadView.tsx:30`, `apps/explore/src/routes/Commons.tsx:14` | Tight row spacing, weak reply grouping and small tab targets | More reading space, indented reply rules, larger reply/tab targets | Craft and hit area: easier scanning and touch interaction |

Raw HTML stays inert text. Unsafe URL schemes are filtered. Markdown images become links so opening a public thread
does not automatically contact an image host. Hidden posts still show their moderation reason instead of their body;
role-only report fields are rendered only when included by the backend. No API/schema/authorization changes were made.

## Considered but rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Markdown task lists | Click-to-complete tasks and a progress bar | There is no task mutation or workflow model yet; a local toggle would misrepresent saved state |
| Roadmap detail | Kanban columns, subtask owners and execution controls | These need agreed workflow semantics and backend support; they exceed the rendering pass |
| Code blocks | Syntax highlighting and copy toolbar on every block | Plain code is already readable and keyboard-scrollable; avoid adding another dependency and repeated controls in this pass |

## Verification

- Owned `bun run check:files` checks passed: formatting, lint, Explore typecheck and graph. Two documented lint
  exceptions preserve keyboard access to scrollable code/table regions; lint configuration was not weakened.
- `heavy bun run --cwd apps/explore test`: **122 files / 601 passed / 0 skipped**. Previous workspace floor:
  120 files / 593 passed. The eight new cases cover Markdown structure, task states, safe links/HTML/images,
  ordinary line breaks, code/table access and hidden-message integration. Existing report visibility/provenance
  checks still pass with formatting markers interpreted as Markdown.
- Local browser scripts: `node /tmp/commons-rendering-review/verify.mjs`; WebKit uses the existing
  `mcr.microsoft.com/playwright:v1.63.0-noble` disposable container with a read-only repo mount. Both browsers
  pass **24 assertions × 2 widths × 2 themes = 96 each; 192 total**. See the complete
  [Chromium receipt](chromium-receipt.json) and [WebKit receipt](webkit-receipt.json).
- Interactions: empty preview; Write/Preview round trip; checked/nested tasks; table rendering; reply from preview;
  focus and draft preservation; cancel reply; over-limit explanation and disabled post; long URL/code overflow;
  keyboard code focus; proposal preview; anonymous roadmap #2 and gap #6 details; no uncaught application errors.
- Screenshots inspected: [desktop preview](desktop-preview.png), [phone dark preview](phone-preview-dark.png),
  [phone proposal](phone-proposal.png), [desktop dark proposal](desktop-proposal-dark.png).
- The shared-checkout full gate stops on pre-existing ignored `.claude/settings.local.json` formatting. The file
  was left untouched. A clean detached checkout of the commit is used for the separate full-gate receipt.

Verdict: **Approve** for this reading/authoring scope. Not verified: authenticated posting and proposal creation,
pending/failure states in a signed-in browser, physical iPhone keyboard/safe-area behavior, load-performance metrics,
normal-motion slow playback, and deployed acceptance. The checkbox UI is read-only content, not workflow execution.
