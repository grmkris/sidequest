# Design: Sidequest Explore

The locked system. Every Hallmark run reads this first and pages share it. Change it on purpose; the file is the rule.

## System

- Genre: modern-minimal
- Shape of the first page: Workbench for the landing (`/`, Corridor hero); every other route is an app screen
- Theme: Coral (dealt 3/3, seed marketplace-where-people-hire-d7f0·c8ce1008·2026-10-22·r0), with the brand kept
- Axes: light/roman-serif/cool · posture: restrained
- Material: stationery on a desk in one light from the left. Warm grey paper for the page, cotton stock for records
  (`bg-card` with `shadow-stock`), a felt desk for the sidebar, a groove for a choice.
- Signature: the receipt. A paid job is a cotton slip with its amounts in tabular figures on dotted leaders and
  `Paid` pressed in the paid ink (`.stamp-paid`): the landing's live rail, the job card, the Job page's side column.

## Tokens

`src/styles.css` is the source of truth. It maps the system onto shadcn's base-nova names, and
`design-tokens.test.ts` holds the contrast and the two dark copies equal. The roles:

```css
:root {
  --background: oklch(0.97 0.006 55); /* paper */
  --card: oklch(0.988 0.0045 80); /* cotton stock */
  --sidebar: oklch(0.943 0.008 64); /* the desk */
  --foreground: oklch(0.21 0.012 38); /* ink */
  --muted-foreground: oklch(0.47 0.013 45);
  --border: oklch(0.87 0.009 55); /* rule */
  --input: oklch(0.62 0.012 50); /* a field's edge, 3:1 on paper */
  --primary: oklch(0.34 0.06 165); /* the brand's evergreen */
  --ring: oklch(0.5 0.1 165);
  --paid: oklch(0.42 0.09 160); /* the settled state */
  --radius: 0.5rem;
}
```

- Faces: Newsreader (display: every page title, the wordmark, offer names), Instrument Sans (body and UI, tabular
  figures included), the system mono only for code, addresses, hashes and call data.
- Shadows: `shadow-stock`, `shadow-stock-lift` (hover), `shadow-groove`, `shadow-popover`, `shadow-chip`, built from
  the per-theme `--stock-*` colours. Never a ring and a shadow on the same surface.
- Radii: 8px on a sheet or a control, 6px on a field, 10px on a picture's frame.

## Controls

- Primary: evergreen stock, 8px, 36px (44px on touch); lifts 1px on hover, sets 1px down on a press.
- Outline: a cotton card, same radius and height. Secondary and ghost are flat paper.
- A choice of two to five (tabs, steps, categories): a groove with the chosen one a cotton card riding in it.
- Toggles and tags: flat paper that becomes a cotton card when on.
- Fields: cotton, 1px `--input` edge, the focus ring an outline, never a border change.
- Status badges: an ink outline in the `-text` shade, sentence case.

## Motion

- Character: brisk and still. `transform` and `opacity` only, the focus ring instant, no height animation, no pulse,
  no image zoom. Under reduced motion movement stops and colour changes stay.

## Variants

- The landing (`/`) is a page: a Corridor hero (the promise, the search, the live receipt) filling the first
  screen, the catalogue, the sellers line, and a mast footer. Its stamp is in `src/components/landing/landing.css`.

## Exports

`src/styles.css` in this project, in shadcn's names. Tailwind, DTCG or other blocks are added here on request.
