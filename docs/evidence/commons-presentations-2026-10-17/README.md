# Commons presentations

Date: 17 October 2026

The implementation adds Streamdown 2.7.0 to Explore, a versioned `sidequest.commons-ui` catalog, optional message
attachments, restricted OpenUI Lang authoring with `@openuidev/lang-core` 1.0.1, and a portable App built with
`@modelcontextprotocol/ext-apps` 2.0.3. Code highlighting uses `@streamdown/code` 2.0.0; optional flowcharts use
`@streamdown/mermaid` 1.0.3. Both load only when requested. Schema validation uses the repository's Zod version;
the API exports the same schema through Effect.

The canonical catalog is owned React code, not the OpenUI React runtime or JSON Render. Markdown remains the
fallback. The MCP App shares the interactive renderer and currently displays the body as plain text. No workflow
executor, persistent reader choice, generated tool call or economic operation is added.

Design and alternatives: [exploration](../../plans/commons-ui-exploration.md),
[ADR-0027](../../adr/0027-commons-presentations.md),
[authoring reference](../../../apps/docs/content/docs/reference/commons-presentations.mdx).

## Local browser evidence

[Fixture receipt](browser-receipt.json): Chromium 153, Explore at 1440px and 390px, and the generated MCP App at
1024px and 390px inside the official SDK's AppBridge fixture host. Checks cover step expansion, local selection,
draft append/focus, table filtering, code highlighting, flowcharts, invalid authoring input, host-mediated links,
explicit reviewed host messages, no writes, no horizontal page overflow and no page errors. The App fixture also
checks that it makes no external requests. These are synthetic local interactions, not an authenticated deployed
posting flow or acceptance in every MCP host.

Screenshots and fixture runner remain at `/tmp/commons-presentations-review/`. A follow-up phone diagram inspection
confirmed a 282.7px SVG inside a 356px frame, with no document overflow; screenshot cropping is not proof of clipping.
The generated HTML was 488,732 bytes raw and 138,687 bytes gzipped. This measures one artifact, not route loading
performance or the incremental cost of the Markdown migration.

## Validation notes

The first temporary checkout omitted Solidity submodule contents, producing a Knip configuration hint. Copying
the exact local submodule contents restored that validation environment. The complete lint gate then found four
new build-script findings; those were fixed without changing rules or the baseline. The generated docs export and
existing MCP resource-list expectation were updated for the new reference and App resource.

Sandbox-only runs could not spawn some existing test helpers or bind local servers (`EPERM`). The isolated full
run uses the normal host environment and the shared `heavy` wrapper. Exit 75 during that run is recorded as capacity
contention. The existing findings in `apps/api/test/docs.test.ts` are recorded in the repository baseline; the full
lint gate checks that their counts do not increase.

Validation and deployment results are appended below when complete.
