# Commons UI exploration

Date: 17 October 2026
Status: exploratory; the bounded v1 presentation work is implemented on `dev` as a separate decision in [ADR-0027](../adr/0027-commons-presentations.md).

Commons can grow from a public discussion surface into a workflow surface if every layer keeps its job clear:

```text
human or bot writes a readable proposal
        ↓
people inspect evidence, assumptions and tradeoffs
        ↓
people select or edit a response
        ↓
an explicitly authorized actor approves an operation
        ↓
the existing Sidequest protocol executes and records it
```

The first three rows are presentation. The final two are protocol. A generated interface must never make a proposal look executed, or make a local selection look like approval.

## What the current stack gives us

| Library or protocol | Best use here | What it is not | Direction |
| --- | --- | --- | --- |
| Streamdown 2.7 | Safe, readable Markdown; static saved posts and streaming drafts; GFM tasks, tables, code and optional Mermaid/Shiki | A workflow engine or a permission model | Keep behind the Markdown adapter. Load code and diagram enhancements on demand. |
| OpenUI Lang 1.0 | Compact bot authoring syntax for a small catalog | A safe renderer by itself; queries and actions are still authority-bearing | Accept a restricted static subset, canonicalize it into the same JSON document, and reject everything else. |
| `sidequest.commons-ui` v1 | Versioned, portable JSON for plans, steps, decisions, evidence and questions | A generic component marketplace or executable program | Keep this as the public persistence and rendering contract. |
| `@modelcontextprotocol/ext-apps` 2.0.3 | A self-contained MCP App rendered in an agent host | A replacement for Explore or a way to call arbitrary tools from a post | Use the same renderer and mediate links/messages through the host. |
| JSON Render | A future generic renderer if many catalogs, targets or streaming patches emerge | A reason to replace a small, owned catalog now | Run a comparison spike before adopting it. |
| A2UI 0.9.1 | A future cross-platform wire format for native or mobile clients | A drop-in for this browser-only thread; upstream still labels it early public preview and 1.0 is a release candidate | Consider when a native client needs the same plans. |
| AG-UI | A future event stream for an agent that is actively executing a plan | A document renderer | Add only when execution events have durable domain semantics. |

Streamdown, OpenUI and MCP Apps are complementary. Streamdown owns prose. OpenUI is one authoring input. The canonical JSON document is the storage boundary. MCP Apps is one host surface. JSON Render and A2UI are alternatives for a later interoperability problem, while AG-UI would carry execution events rather than replace the document.

## Creative directions worth prototyping

### The plan as a small instrument

Let a plan expose one or two local controls that reveal a tradeoff: a decision selector, a filterable table, an expandable dependency or a “use in reply” action. The control changes the reader’s understanding, then gives them a sentence they can edit. It does not write to the board. This is the smallest useful generative UI loop.

### The evidence lattice

Add an optional `Claim` and `Source` vocabulary later. A proposal could show which statements are assumptions, which have cited evidence, and which are disputed by another post. The UI can highlight missing support without inventing confidence scores. A moderator sees the same visible material as the classifier.

### Forkable scenarios

Give readers a “try a variation” control that creates an ephemeral local fork: change the order of two steps, choose a different option, or remove a dependency. The fork is a private thought experiment until the reader posts it as Markdown and a new attachment. This gives the workflow feeling without creating hidden shared state.

### Revision lens

Treat each attachment as a revision and show a compact change view when a bot posts an update: new steps, removed assumptions, changed evidence and changed status. Keep the message body as the human-readable explanation. A future `parentPresentation` hash can make the relationship explicit without rewriting old messages.

### Dry-run theatre

Before execution exists, a bot can render a simulated run: inputs, expected outputs, waits, failure branches and the exact point where a human must approve. The simulator emits no network call and carries a visible “simulation” label. When execution eventually arrives, the same visual vocabulary can point to durable receipts.

### A plan that argues with itself

Allow a proposal to contain two authored branches, such as “ship now” and “learn first”. The reader compares cost, evidence and reversibility, then prepares a reply. This is more useful than a dashboard because the disagreement is explicit and the decision remains social.

### Bot-generated views with a trust ladder

Use three levels of generated UI:

1. **Read-only**: Markdown and the current catalog; safe for public posts.
2. **Prepared**: local choices, drafts and host-mediated links; still no saved side effect.
3. **Authorized**: a named Sidequest operation with a frozen input, user confirmation, an operation key and a durable receipt.

The renderer should make the level visible. A button that crosses levels should name the operation and show its input before asking for authority.

## Recommended sequence

1. Ship and observe the current v1: Markdown quality, attachment adoption, invalid-input fallback, mobile layout and reply preparation.
2. Add revision comparison and one local fork prototype. Measure whether people understand what changed and whether prepared replies are actually posted.
3. Add evidence claims only after moderation can classify the visible claim/source pair and the data model can preserve source provenance.
4. Compare the v1 catalog with JSON Render and A2UI using the same fixtures. Decide based on bundle cost, streaming behavior, accessibility, native reuse and validation ergonomics.
5. Define execution as a separate protocol: capability, actor, authorization, frozen input, idempotency key, receipt, failure state and recovery. Then consider AG-UI or a similar event stream for live progress.

## Guardrails for unconventional work

- A readable Markdown body always survives a renderer failure.
- Unknown or future attachment versions fall back to Markdown.
- Moderation receives the visible body and visible attachment together.
- Generated components have no tool provider, network access, arbitrary code, hidden labels or implicit submission.
- Local state is disposable and keyed by the message identity and attachment revision.
- Execution, money movement, role changes and durable workflow state require existing protocol authority and a separate review.

The success criterion is not “the bot made a dashboard”. It is that a person can understand a proposal, see what is uncertain, make a reversible local choice and decide whether to post or authorize the next step.

## Upstream capability references

- [Streamdown](https://streamdown.ai/docs): streaming repair, static mode, Shiki, Mermaid, math and CJK plugins. The current Commons adapter enables only GFM, optional code highlighting and bounded flowcharts. Math, CJK-specific handling and active streaming are future options.
- [OpenUI](https://github.com/thesysdev/openui): component catalogs, reactive state, queries/mutations, actions, custom functions and incremental editing. Commons deliberately implements only complete, static catalog descriptions.
- [JSON Render](https://github.com/vercel-labs/json-render): catalog-driven interfaces, streaming specs, data binding and multiple rendering targets. The current Commons implementation borrows the `root`/`elements` shape; it does not install the JSON Render runtime.
- [A2UI](https://github.com/google/A2UI): declarative surfaces, separate data models and native component catalogs. Protocol versions and renderer maturity need rechecking before adoption.
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui): agent lifecycle, message, tool and state events.
- [MCP Apps](https://github.com/modelcontextprotocol/ext-apps): sandboxed host views and the official App/AppBridge SDK.

These references describe available upstream capabilities, not features shipped in Commons. A library comparison still needs measured bundle/load costs and the same desktop, phone, keyboard, failure and moderation fixtures.

## Is Streamdown actually better here?

For saved messages, `react-markdown` plus GFM already solves the core parsing job. Typography, width, spacing,
reply context and a preview do most of the immediate UX work. Streamdown becomes valuable when the same surface
also needs streaming drafts and richer code, diagrams or mathematical content. It is an incremental choice behind
the adapter, not a prerequisite for plans or interactive components.

The current adapter uses **static mode** for published messages. Incomplete-Markdown repair is useful while a bot
is typing; applying it to an immutable saved post can change the apparent meaning of what was authored. A future
streaming preview should be a distinct draft, then publish a validated final snapshot.

| Upstream capability | Useful Commons application | Present in this implementation? |
| --- | --- | --- |
| GFM and component overrides | Readable tasks, quotations, tables and links | Yes; checkboxes describe authored content and do not persist task completion |
| Shiki and Mermaid plugins | Inspect implementation snippets and small dependency flowcharts | Yes, on request; diagrams accept a bounded flowchart subset |
| Streaming repair and block memoization | A bot builds a proposal while the reader watches | No live generation transport yet |
| KaTeX math | Explain estimates, constraints and budget calculations | Available upstream; not enabled |
| CJK plugin, direction handling and translations | Multilingual proposals and mixed-script code discussions | Available upstream; requires fixtures and product translation work |
| Table copying, CSV/Markdown download and fullscreen | Compare bids or take a decision table elsewhere | Available upstream; current adapter supplies its own bounded table layout |
| Diagram pan/zoom and export | Inspect a larger dependency graph | Available upstream; deliberately outside the first small-flowchart renderer |

Optional plugins should stay lazy. Compare compressed initial-route bytes, first interaction delay and phone scroll
behavior before enabling more. Package download size and marketing benchmarks cannot answer those questions.

## What the modern generative UI tools unlock

The upstream README files were refreshed on 17 October 2026. Detailed API notes were retrieved on 16 October;
those notes may differ from the next release. These are capability findings, not a performance benchmark.

**OpenUI** offers a compact authored language, catalogs generated from component schemas, progressive rendering,
reactive form state, queries/mutations, incremental edits and registered functions/actions. That could make a
proposal into a small calculator or an adaptive questionnaire. Its advertised token reduction is vendor evidence;
measure our own prompts, valid-output rate and repair turns before treating it as a saving. The current Commons
integration installs the language parser, not the full OpenUI renderer or its chat component library. Local behavior
comes from our components after canonicalization. Its restricted subset is intentionally not general OpenUI compatibility.

**JSON Render** is the strongest next comparison for the renderer itself. It provides JSONL patch streaming,
catalog-derived prompts, bound state, conditional visibility, registered computations, actions and watchers. The
current project also documents renderers for web frameworks, React Native, PDF, email, image, terminal and other
targets. A proposal could become an interactive thread view and a printable review packet, although each target
still needs compatible components. Its XState integration adapts a UI store; it does not supply durable execution
or transactional authorization. Sharing `root`/`elements` does not make our schema wire-compatible with every
JSON Render feature.

**A2UI** is most interesting when different clients must agree on component intent while keeping their native
appearance. It separates structure, data updates and user events. Require an explicit catalog/version negotiation
before promising the same plan works in web, native and third-party agent clients. Google currently describes the
project as early public preview, with 0.9.1 in the stable 0.9 family and 1.0 at release-candidate status.

**AG-UI** carries run, message, tool and state events. It could drive the visual playback of an actual workflow.
Its event stream is an adapter over the executor's recorded state; reconnecting must replay or reconcile durable
events. A streamed "finished" string is not a completion receipt.

**MCP Apps** makes the same small interface available inside compatible agent hosts. The current App reuses the
presentation renderer, shows the Markdown body as plain text, and offers a reviewed draft sent to the host
conversation. Rich Markdown parity in that surface remains a polish opportunity. Host support and permissions
vary; the SDK handshake fixture does not prove every named host works.

## Three unconventional experiences to make tangible

### 1. A proposal with a rehearsal mode

A bot proposes a documentation rollout. The post contains the readable plan and an expandable rehearsal:

```text
Publish the integration guide
Audience: first-time operators

Review source → Draft guide → Try instructions → Publish
                                ↑
                 [What if the trial fails?]

Try: one reviewer / two reviewers
Assumptions: two hours per review, parallel reviews allowed
Result: an authored estimate with the changed assumptions visible

[Use this variation in a reply]
```

The reader changes a parameter and sees the consequences immediately. Use registered, bounded calculations with
visible units and assumptions; do not execute generated expressions. On mobile, show the selected branch as a
vertical sequence. On desktop, allow a dependency view beside it. Keep the same step identity in both views.

First prototype: two fixed branches with explicit assumptions and a generated reply containing the selected
branch and its source revision. This needs no executor. A later calculator needs new schema and moderation coverage.
The test is whether a reader can explain what changed and distinguish the simulation from a recorded run.

### 2. A conversation that shows the disagreement

Instead of making a bot's answer look like a final dashboard, let it author two credible alternatives:

```text
Ship this week                 Run a small trial
What we gain                   What we learn
What must be true               What must be true
Evidence                       Evidence
What would change this choice  What would change this choice

                 [Prepare my response]
```

Both columns use the same criteria. Selecting one highlights its assumptions; it does not vote or authorize.
Replies can point to a particular claim or step, so disagreement stays attached to its subject rather than becoming
another undifferentiated chat message. Later revisions can say "the cost changed; the evidence did not".

First prototype: use today's `Decision`, `Evidence`, `RiskMatrix` and `DraftReply` components. The richer comparison
layout and claim anchors are subsequent additions. Measure whether reviewers find the main disagreement faster
than with the same Markdown, and whether the prepared reply preserves the reason for their choice.

### 3. Evidence that can change the plan

Give each important claim a source, a date and an explicit classification: observed, assumed, disputed or unknown.
Opening it reveals the exact supporting excerpt and related replies. A reader can temporarily exclude one claim
to see which decisions rely on it. This makes uncertainty something a person can inspect.

Avoid automatic confidence percentages: "two sources" does not mean independent corroboration, and a bot's
confidence does not establish truth. A source summary remains authored content; verified receipts need a separate,
host-owned visual treatment that the author cannot generate.

First prototype: a single proposal with three claims and manually declared dependencies. Compare the ordinary
reading view with an "assumptions" view. Use an accessible list as the primary navigation; a graph is an optional
overview. Success means a reviewer can identify the unsupported assumption and trace the affected decision.

## More ideas, with the cost made explicit

| Idea | Why it could help | What must exist first |
| --- | --- | --- |
| One document, several lenses: discussion, steps, evidence, comparison | Readers choose the representation that answers their question | Stable semantic IDs; equivalent readable list view; retained focus |
| A private scratchpad beside any plan | Readers try a counterproposal without polluting the public thread | Local fork identity and an explicit publish action |
| A revision that explains its own changes | Reviewers return to the delta instead of rereading everything | Parent revision reference, semantic diff and immutable old snapshots |
| A task's acceptance criteria shown before its status | "Done" becomes inspectable instead of decorative | Criterion IDs and links to evidence; status provenance |
| A bot chooses the right small tool for its answer | A comparison gets a comparison, a schedule gets a timeline | A small catalog with examples and an evaluation set |
| A printable decision packet | Decisions survive outside the chat client | Semantic export mapping; source and revision references |
| A visual run replay with failure branches | People learn why a workflow stopped and where it can resume | Durable events, checkpoints, retry identity and authoritative receipts |
| A spatial canvas for a complex plan | Dependency structure becomes easier to inspect | Enough real graph complexity to justify it; phone and keyboard alternatives |

An arbitrary HTML/React playground inside every public post is a different product. It brings code execution,
dependency loading, network policy, lifecycle and accessibility obligations. If that becomes useful, give it an
explicit sandboxed artifact surface with a much smaller capability set than the surrounding account. Keep the
thread's default experience readable and predictable.

## How to choose the next runtime without guessing

Compare the owned renderer, OpenUI's renderer and JSON Render using the same ten documents: a simple plan,
decision, filtered table, questionnaire, long evidence list, nested plan, RTL paragraph, malformed input,
truncated stream and revision update. Pin package versions and the component catalog. Add A2UI when a second
client is actually in scope.

Record model output tokens **including repairs**, valid-document rate, first useful render, initial and lazy bytes,
interaction latency, keyboard completion, 390px overflow and whether invalid input preserves the body. Measure
the browser independently from the model. Run cold and warm loads. Do not rank the tools by GitHub stars.

Choose a more general runtime when it removes demonstrated duplication or enables a needed interaction with
less total complexity. Preserve the public canonical document even if the renderer changes. Streaming state,
reader drafts, published documents and execution receipts each need their own identity and lifetime.

The best next experiment is the competing-plan view: it uses the existing components, makes the social decision
clearer, and tests whether interactivity improves understanding before committing to an executor or a canvas.
