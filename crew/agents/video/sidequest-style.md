# Sidequest house style for video and cards

Use this for any job about Sidequest itself: launch media, receipts, explainers, "meet the crew". Its values come from
the shipped launch cuts. The job's brief wins on facts and scripts; this file wins on look, render and checks.

## Inputs (public)

- **Brief, facts and claim rules:** <https://media.sidequest.exchange/f/briefs/launch-week.md>. Every number on
  screen comes from it, and from a fresh on-chain read where the brief says to re-check.
- **Style reference:** the 40 s vertical
  <https://media.sidequest.exchange/f/launch-40s-vertical/sidequest-40s-vertical.mp4> and the 75 s landscape
  <https://media.sidequest.exchange/f/launch-75s/sidequest-75s-landscape.mp4>. Watch one before you start.
- **Editable source of both:** <https://media.sidequest.exchange/f/launch-source/source.zip> (62 MB; layout below).
- **Brand:** <https://media.sidequest.exchange/f/mark-svg/mark.svg> (the mark),
  <https://media.sidequest.exchange/f/app-icon/icon-1024.png>; Geist is in the source zip
  (`assets/fonts/Geist.woff2`) and on Google Fonts. Everything in the kit: <https://media.sidequest.exchange/>.

## Look

| Role          | Value                                                                |
| ------------- | -------------------------------------------------------------------- |
| Canvas        | `#101b15` (dark forest green); continuous, never a flat slide change |
| Text          | `#f0f3e8` warm white                                                 |
| Accent        | `#c5ed87` lime: the one thing to look at, progress, the task packet  |
| Artifact fill | `#183021` dark green cards and sheets                                |
| Secondary     | `#c9b7f3` lilac for a second branch or agent, sparingly              |
| Caution       | `#f2a88c` coral: disclosures and warnings only                       |

- **Type:** Geist only. Headlines 95–170 px for short single phrases (170 only for one or two words); labels 30–40 px;
  nothing under 26 px. Big, few words: never print the narration sentence as a headline.
- **Brand:** the mark and "sidequest" lowercase, top left, small; the end card uses the mark large with
  `sidequest.exchange`.
- **Objects:** tangible things that move: a lime task packet (a portrait sheet with three dark strokes), branches drawn
  as lines that end on nodes, a deliverable that comes back (a page, a PR, a film frame, a chart). Numbers appear as
  receipts: short hash `0x234b…21cf`, an Agent ID `#10399`, an amount with its unit.
- **Vertical safe area (1080×1920):** keep words out of the top 220 px, the bottom 420 px and the right 140 px, where
  TikTok, Reels and Shorts draw their UI. Captions sit just above the bottom margin.
- **Avoid:** code dumps, fake dashboards, card-grid templates, floating stock icons, glitch, strobe, film grain, neon,
  bouncy text, gradients that are not the forest canvas, any person's likeness.

## Motion

- Entrances 0.25–0.55 s with `expo.out` or `power3.out`; no bounce or elastic.
- A new meaningful change every 0.8–1.8 s, but hold each headline at least 1.5 s so it reads on a phone.
- Cause and effect: a branch leaves the plan, a result comes back to it. Draw strokes with a measured
  `getTotalLength()`; scale through explicit `fromTo`.
- Macro drift at most 3% scale or 15 px. Cuts are clean; objects that continue across a cut land in the same place.
- HyperFrames rules: one paused GSAP timeline per composition, seek-safe; no `Math.random`, `fetch`, autoplay or
  `requestAnimationFrame`.

## HyperFrames

Pin the version the launch cuts were made with: `npx --yes hyperframes@0.8.150 <command>`. Load the skills `hyperframes`
then `hyperframes-core`; `hyperframes-animation` and `hyperframes-keyframes` for motion; `hyperframes-audio` for the mix;
`hyperframes-registry` before hand-building a named effect; `general-video` or `product-launch-video` as the workflow.

## Starting from the source zip

`source.zip` holds two finished projects, `sidequest-master-75s-astra/` (16:9) and `sidequest-vertical-40s-astra/`
(9:16). For a vertical job, copy the vertical one:

- `index.html`: the built composition (every scene, captions and the audio mix). Edit it directly; the Python build
  scripts beside it are optional.
- `assets/fonts/Geist.woff2`, `assets/vendor/gsap.min.js`, `assets/mark.svg`: keep the paths project-relative.
- `assets/audio/music.wav` and `goblin-epic-source.mp3`: the launch music bed (first-party). `voice.wav` and
  `assets/eleven-voice/` are the launch narration: do not reuse its lines for a new script.
- `timing.json`, `captions.json`, `captions.vtt`, `SCRIPT.md`, `CLAIMS.md`: the old cut's timing, captions and claims.

To adapt a scene: keep its layout and motion, replace its words with the new beat's, set the scene's `data-start` and
`data-duration` to the new beat times, remove scenes you don't need, and drop the voice `<audio>` when the job is text
and music only. Rebuild the captions from your own script.

## Render (4 CPUs, 55-minute run)

```bash
npx --yes hyperframes@0.8.150 check
npx --yes hyperframes@0.8.150 render --quality delivery --workers 2 --output renders/<name>.mp4
```

The 40 s vertical rendered in 1.5 minutes with 4 workers on 16 cores; on 4 CPUs plan on 3–6 minutes. Budget: build by
minute 25, first full render by minute 35, then fix and re-render once. Check `render --help` for a faster quality for
test renders.

## Audio

- Loudness about -16 LUFS integrated, true peak at or below -1.5 dBTP. Measure the final MP4:
  `ffmpeg -i out.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12`.
- Fade the music in over at least 0.3 s and out over at least 1 s at the end; no hard cuts at scene seams.
- With a voice (Gemini TTS), carve the music under it (`hyperframes-audio` voiceover carve, strength about 0.8) and keep
  the bed well under the voice. Text-and-music jobs: the bed alone, steady.

## Check before you deliver

- `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration -of json out.mp4`:
  H.264 and AAC, the brief's exact size, 30 fps, the length within ±1 s, under 60 MB.
- A contact sheet, looked at: `ffmpeg -i out.mp4 -vf "fps=1/4,scale=270:-1,tile=5x2" sheet.png`. No clipped or
  overlapping words, nothing in the platform UI zones, readable with the sound off.
- Every number on screen matches the brief (and the chain where it says to re-check). Read them out one by one.
- The end card carries the brief's disclosures and `sidequest.exchange`.

## Claim rules (from the brief)

Utility only: no price, FDV, market cap, returns, "safe", "trustless", "rug-proof", "locked forever" or "can't sell".
Say "the founder", never a name. Disclose: contracts unaudited; the founder holds the Safe keys (1-of-1 now, 2-of-3 by
20 Oct); Sidequest's first agents are founder-operated (related party). A slash moves the backing, so say "the backing
gets slashed", not "the agent loses its money". Label anything from testnet as testnet.
