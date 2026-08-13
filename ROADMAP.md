# Roadmap

Ordered by what unblocks the most, not by what is most fun. Each entry says
where it slots in, so none of this is a rewrite.

## Working now

- Stamp brush: arc-length spacing, Catmull-Rom, stabiliser, pressure → size and
  opacity, tilt → size, speed → taper
- Eraser (tool, or flip the pen over), eyedropper
- Layers: add, duplicate, delete, reorder, visibility, lock, opacity, 16 blend modes
- Undo/redo across layers, bbox-scoped, structural ops included
- Pan / zoom / rotate, pinch gestures, palm rejection
- X / Y / XY symmetry
- Selections: rect, ellipse, lasso. Paint and erase clip to the mask.
- Transform: move / resize the selected pixels on the active layer
- Selection + transform lockstep with X / Y / XY symmetry about the document centre
- Export PNG (native dialog in Electron, download in browser)

---

## Next, in order

### 0. Wintab input backend  — BUILT, needs a real drawing session

Live in the app. `[wintab] {"supported":true,"active":true,...}` at startup;
the status-bar pill reads `wintab` when it is driving.

Benchmarked on real strokes before committing to polling over a native addon:

| | first run | after `timeBeginPeriod(1)` |
|---|---|---|
| poll gap p95 | 18.16 ms | **3.08 ms** |
| packets per poll | 3.03 | **1.01** |
| inter-sample gap p50 | 0 (bursty) | **4.98 ms** = the 194 Hz device rate |

`packetsPerPoll ≈ 1` means the queue drains as fast as it fills, so polling was
enough and no native addon was needed. Windows' default 15.6 ms timer
granularity was the entire original latency; raising it to 1 ms is a 7x
improvement (p50 15.56 → 2.22 ms, measured in `scripts/wintab-bench/timer-test.cjs`).

Pressure resolution actually observed on one session: **2233 distinct values via
Wintab vs 177 via Pointer Events**, and 1866 vs 2 with Windows Ink switched off
in the driver — i.e. Wintab keeps working when Windows Ink does not.

**Sub-pixel coordinates.** A default Wintab system context reports whole
virtual-screen pixels. Measured here that discarded **7x the precision on X and
13.7x on Y** — the digitiser resolves 44801 x 29601 counts, the context mapped
onto 6400 x 2160. Scaling `lcOutOrg`/`lcOutExt` by 32 recovers it as fixed-point
screen pixels while keeping the driver's screen mapping (verified honoured via
`WTGetW`; `scripts/probe-wintab-resolution.cjs` and `probe-wintab-subpixel.cjs`).

This was being misdiagnosed as digitiser noise and chased with filters. The
tell was the artifact's *shape*: regular stair-steps, not fuzz. Steps mean
quantisation; fuzz means noise. Worth remembering before reaching for a filter
again.

Still to verify with a pen, in the app rather than the bench:
- stroke start/end from the tip switch feels right
- coordinate mapping is exact at every zoom and on a second monitor
- the inverted-pen eraser (currently inferred from negative altitude —
  UNVERIFIED; `PK_CURSOR` is the rigorous route if it misbehaves)
- the barrel button arrives as `BARREL_LOWER` with no OS ring

Then: a settings toggle (Wintab / Pointer Events), and bind the barrel button to
something useful now that it no longer generates a right-click.

#### Original plan, kept for context

Windows Ink is the wrong input path for a painting app, and every established
tool says so: Krita defaults to Wintab, Photoshop users have been setting
`UseSystemStylus 0` for ten years, Clip Studio ships a selector. Probed on this
machine, Wintab gives **16,384 pressure levels against Windows Ink's 1024**, at
200 Hz, with real twist and no coalescing loss. It also makes the OS pen-feedback
ring disappear, because no WM_POINTER right-click is ever generated — and it
hands us the barrel button as a plain bit, so stylus buttons become ours to bind
rather than something to avoid.

Shape of the work:

1. ~~Open a Wintab context, read the queue.~~ **Done as a prototype** in
   `scripts/wintab-bench/wintab.cjs`. Self-test passes on this machine: context
   opens against the real HWND, queue sizes, polls cleanly, closes.
2. Deliver to the renderer. **Still the open question**: Wintab's native
   delivery is `WT_PACKET` window messages, which Electron cannot return values
   for, so the realistic options are polling the packet queue from the main
   process (simple; adds timer jitter plus IPC) or a native addon with its own
   thread (fast; more machinery). `npm run bench:wintab` measures the polling
   option against Pointer Events on the same stroke. Decide from those numbers.
3. `src/engine/input.ts` grows a second source. The brush engine does not
   change — it already consumes `StrokePoint` and knows nothing about origin.
4. A Krita-style setting: Wintab (default on Windows when present) / Pointer
   Events, with automatic fallback.

Pointer Events stays the path on Linux and macOS, where it is already correct.

**Do not ship stylus-button workarounds in place of this.** The `S`-to-resize
binding is a convenience, not the answer.

### 1. Document format (`.vellum`)
Nothing else is safe to build on top of a document you cannot save. Zip of a
JSON manifest plus one PNG per layer is enough to start; the manifest already
mirrors `PaintDocument`.
**Where:** new `engine/io/`, plus two more preload calls.

### 2. Selections — BUILT (wand is a follow-up)
A selection is a mask Surface (`engine/selection.ts`). `Surface.draw` takes an
optional clip; the compositor and stroke commit pass the mask so paint and erase
stay inside it. Dabs that cannot touch the selection AABB are skipped.

Rect, ellipse and lasso are live. Transform (`V`) moves and resizes the selected
*pixels*, not just the marquee. With X / Y / XY symmetry, selecting or
transforming one side mirrors the counterpart(s) about the document centre so
both sides stay in lockstep.

**Wand** is deliberately not stubbed. Magic-wand / flood-select needs a
connected-component walk over the composite, a threshold, and contiguous vs
global modes — that is its own piece, not an empty button. Follow-up.

### 3. Brush textures and shaped tips
`TipCache` already isolates tip generation. Add an image-based mask, tip
rotation (follow direction or twist), scatter, and angle jitter.
**Where:** `brush/tip.ts` and the dab loop in `brush/stroke.ts` — nothing else.

### 4. Rulers and guides
Perspective, ellipse, and line guides constrain the point *before* it reaches
the stabiliser: `StrokePoint → StrokePoint`.
**Where:** a transform slot in `input.ts`, ahead of `extendStroke`.

### 5. Custom title bar and menus
`Menu.setApplicationMenu(null)` today so shortcuts have exactly one code path.
A frameless window with a React title bar keeps that property and looks better
than the stock bar.
**Where:** `main/index.ts` + a new renderer component.

---

## Deferred deliberately

**Tiled storage.** The usual reason to tile — undo memory — is already solved by
bbox patches. The remaining reasons are sparse allocation on very large
documents and multi-threading. Tiling now would mean compositing hundreds of
tiles per frame in Canvas 2D, which is slower than one blit. `Surface` is the
containment boundary for when it is worth it.

**WebGPU.** Only two places touch Canvas 2D drawing: `Surface` and
`Editor.render`. Do this when profiling says the dab loop is the wall, not
before. Current numbers say it is not close.

**Colour management.** Real, and everyone gets it wrong. Needs a decision about
working space before any pixel code changes.

**Worker/OffscreenCanvas rendering.** `Surface` would need to stop assuming
`document.createElement`. Worth it only alongside tiling.

---

## Known rough edges

- `Compositor` copies the full active layer per frame during a stroke when the
  layer has opacity or a blend mode. Should be restricted to the stroke's dirty
  rect. Invisible at current document sizes; will not stay that way.
- Layer reorder is buttons, not drag-and-drop.
- No layer thumbnails.
- Document size is hard-coded in `App.tsx`. Needs a New Document dialog.
- `prototype/index.html` has drifted from the app and is kept only for A/B
  comparison of feel.

---

## The actual next step

None of the above matters as much as drawing on it with a real tablet. Every
measurement so far uses synthetic pen events. Draw for twenty minutes, then
reorder this list.
