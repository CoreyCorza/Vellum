# Vellum

A drawing and painting application. Electron + TypeScript, Canvas 2D now,
WebGPU later if measurement says so.

```bash
npm install
npm run dev
```

| command | what it does |
|---|---|
| `npm run dev` | Electron shell with HMR — the real app |
| `npm run dev:web` | the whole editor in a browser tab, no Electron restart |
| `npm run build` | typecheck + bundle main/preload/renderer |
| `npm run verify` | engine behaviour checks against the built bundle |
| `npm run smoke` | boots the real shell, asserts it mounted cleanly |
| `npm run dist` | unpacked Windows build in `release/` |

Use `dev:web` for brush-feel and UI work; it reloads in about a second. Use
`dev` when you need the native save dialog or want to check real-shell
behaviour. The renderer never imports Electron — everything native goes through
`platform.ts`, which is why both work.

The original single-file prototype is kept at `prototype/index.html`. It still
runs by double-clicking, and it is useful for A/B-ing feel against changes.

---

## Layout

```
src/
  engine/          pure TypeScript. no React, no Electron, no DOM framework.
    surface.ts       the ONLY place raw pixels are touched
    document.ts      layers + stack operations
    compositor.ts    flattens the stack; caches the prefix below the active layer
    camera.ts        pan / zoom / rotate — a view, not the artwork
    history.ts       command stack; pixel patches are bbox-scoped
    input.ts         Pointer Events → StrokePoint. all platform quirks live here
    editor.ts        wires it together, owns the frame loop
    brush/
      settings.ts      brush parameters + presets
      tip.ts           pre-rendered tip sprite
      stroke.ts        stabiliser → spline → arc-length dab spacing
  main/            Electron main process
  preload/         the entire native surface area (two functions)
  renderer/src/    React. panels only. never touches pixels.
```

**The line that matters:** `src/engine` has no framework imports. The UI reads
engine state through a subscription and calls methods on it. Keep it that way —
it is what makes the renderer swappable and the engine testable headlessly.

---

## Controls

| | |
|---|---|
| `B` / `E` / `I` | brush / eraser / eyedropper |
| hold `Alt` | temporary eyedropper |
| `[` `]` | size down / up |
| `Ctrl` + wheel | size |
| **hold `S`, move ←→** | **resize brush — hovering or in contact, no button** |
| `Alt` + right-drag ←→ | resize brush (mouse-friendly; see the pen note below) |
| wheel | zoom at cursor |
| **`Ctrl` + space + left-drag ↑↓** | **zoom — up is in, down is out** |
| `Alt` + wheel | rotate canvas |
| space-drag, middle-drag, barrel-drag | pan |
| `Shift` + middle-drag | rotate |
| two fingers | pinch zoom + rotate + pan |
| flip the pen over | erase, without changing the selected tool |
| `M` | cycle symmetry |
| `Shift+N` | new layer |
| `F` / `0` / `1` | fit / fit / 100% |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+S` | export PNG |

**Sliders:** drag (no threshold — moves on contact), shift-drag for fine, wheel
to nudge, double-click for default, click the number to type it.

Once a pen has been seen, touch navigates but never paints — palm rejection.

---

## Windows Ink

**Correction — an earlier version of this file said pressure "requires" Windows
Ink. That is true of the *browser* path only, and it is not where this app
should end up.**

Chromium on Windows ingests pen exclusively through WM_POINTER (Windows Ink), so
Pointer Events go dead when you untick "Use Windows Ink" in the driver. That is
a Chromium-on-Windows limitation, not a web-platform one — on Linux the same
code gets pressure and tilt via XInput2 / `tablet_v2` with no equivalent layer
at all.

Every serious painting app on Windows avoids Windows Ink:

| app | mechanism |
|---|---|
| Krita | Settings → Tablet → Wintab (default) |
| Photoshop | `PSUserConfig.txt` → `UseSystemStylus 0` — the workaround artists have used for a decade |
| Clip Studio | Tablet Service selector (Wintab / Windows Ink) |

All of them mean the same thing: talk to **Wintab**, the tablet driver's own API
(`wintab32.dll`, shipped by Wacom, XP-Pen and Huion alike). Electron gives us a
real Windows process, so we can do the same. This is not a reason to go native.

Measured here with `node scripts/probe-wintab2.cjs`:

```
Wintab 1.1 · "Pentablet" (XP-Pen) · 200 Hz
  pressure    0..16383 = 16,384 levels
  orientation azimuth 0..3600, altitude 0..900, twist 0..3600
```

Windows Ink's WM_POINTER pressure is **1024 levels**. Wintab exposes **16x** the
pressure resolution on identical hardware, plus real twist and an uncoalesced
packet queue. Adopting it is a quality upgrade, not merely a workaround — and it
removes the OS-drawn ring for free, since no WM_POINTER right-click is ever
generated. See ROADMAP.

The quirks that come with Windows Ink are mostly the *browser's* default gesture
handling, and this app opts out of all of it:

- `touch-action: none` on the canvas and every slider — no drag threshold, no
  scroll/tap/long-press disambiguation delay.
- Press-and-hold context menu suppressed except in text fields.
- Tap-highlight and double-tap-zoom off.
- Barrel button pans instead of opening a menu.

### The OS-drawn pen rings

Windows paints its own visuals under the nib — the ring on tap, and the ring
that appears when you hold the barrel button — before the app sees anything.
No amount of CSS or canvas work removes them.

**The Settings UI does not actually turn them off.** Unticking "Show visual
effects" under Pen & Windows Ink leaves the real registry values untouched.
Verified on this machine with every box unchecked:

```
HKCU\Control Panel\Cursors
  GestureVisualization = 31   (0x1F — all five feedback bits ON)
  ContactVisualization = 1
```

`GestureVisualization` is a bitmask: `0x01` press-and-hold, `0x02` tap, `0x04`
double-tap, **`0x08` right-tap** (the ring on right-click), `0x10` flicks. Set
it to `0` and sign out/in:

```
reg add "HKCU\Control Panel\Cursors" /v GestureVisualization /t REG_DWORD /d 0 /f
reg add "HKCU\Control Panel\Cursors" /v ContactVisualization /t REG_DWORD /d 0 /f
```

Defaults to restore: `31` and `1`. This is machine-wide and is the actual fix —
it is why the rings appear in every application, not just this one.

`src/main/penFeedback.ts` additionally sets the
`MicrosoftTabletPenServiceProperty` window property with
`TABLET_DISABLE_PENBARRELFEEDBACK | PENTAPFEEDBACK | PRESSANDHOLD | FLICKS`,
which covers our window only. Electron exposes no API for it, so it goes through
a small FFI call (`koffi`). Non-fatal — failure just means the rings stay.

Two things that make this work and are easy to get wrong:

- **It must be set on the CHILD windows.** Chromium renders into
  `Chrome_RenderWidgetHostHWND`, and that is the window the tablet service
  inspects. The first version set only the top-level frame and provably did
  nothing (`windows: 1`, and the rings persisted).
- **It must be re-applied after the window is realised.** Child HWNDs do not
  exist at creation time. The app applies at `on-create`, `ready-to-show` and
  `did-finish-load`; the log shows `windows` going 1 → 3.

`npm run penprop` sets and reads the property back on the frame and every child.
The app logs `[pen] ready-to-show: {"applied":true,"windows":3,...}` at startup.

**It does not fix the barrel-button ring.** Measured on this machine (XP-Pen):
right-click with a *mouse* draws nothing; the same gesture with the *pen* draws
the ring; turning Windows Ink off in the tablet driver removes the ring but also
kills pressure. The window property is a Vista-era mechanism honoured by the
legacy tablet service, and the modern WM_POINTER stack appears to ignore it. It
is kept because it is harmless and may still suppress tap feedback — delete
`src/main/penFeedback.ts`, its two call sites and the `koffi` dependency if you
would rather not carry a native module.

### Design consequence: don't bind pen gestures to right-click

If Windows insists on drawing under the nib whenever the pen produces a
right-click, the durable answer is to stop producing one. That is why brush
resize has a second binding — **hold `S` and move** — which works while merely
hovering and needs no button at all. Any future radial/pie menu should use the
same shape rather than the barrel button.

Two ways to get that onto the pen itself:

- **XP-Pen driver:** map the barrel button to a keystroke (`S`) instead of
  "Right click". Windows Ink stays on, pressure keeps working, no right-click is
  ever generated, so no ring.
- **ExpressKey:** same idea, on the tablet body.

### Keyboard focus

Focus belongs to the canvas unless you are typing. Clicking a widget otherwise
leaves it focused and the browser keeps routing keys to it — space re-toggles
the last checkbox instead of panning. Focus is dropped after any activation, and
space additionally cancels and blurs. `<select>` is excluded from the blur (its
dropdown is an OS popup) and is blurred on `change` instead.

The status bar shows `pen` or `mouse` live — if pressure ever goes missing, look
there first.

**Escape hatch:** if Windows Ink is ever genuinely unacceptable, the main
process can load Wintab via a native addon and feed pressure to the renderer
over IPC. `input.ts` is the only file that would change, because the brush
engine consumes `StrokePoint` and knows nothing about where it came from.

---

## Design notes worth keeping

**Stamp-based brush.** Strokes are dabs placed at even *arc length*, not a
polyline. The interval is recomputed per dab from the current radius, so a
pressure-tapered stroke stays evenly deposited end to end. Drawing one dab per
input sample — the obvious approach — makes ink density track how fast you moved.

**Wash compositing.** A stroke accumulates into its own buffer and merges into
the layer once, at stroke opacity, on pen-up. Overlaps inside one stroke
therefore cannot darken past the opacity you set. The eraser uses the same
buffer with a `destination-out` merge, which is why it previews correctly and
caps at its opacity instead of chewing straight through.

**Prefix-only composite cache.** Layers *below* the active one are cached into
one surface. Layers *above* are not, and that is deliberate: blending is
left-associative, so a cached prefix is exactly correct while a cached suffix is
not — pre-flattening two multiply layers gives different pixels than blending
them in order.

**Undo patches are Surfaces, not ImageData.** `getImageData` forces a GPU→CPU
sync. Measured here it cost **17 ms at every pen-up** — a dropped frame exactly
where you notice one. Canvas-to-canvas `extract`/`restore` stays on the GPU:
**0.33 ms**. Removing the sync point also let the driver pipeline the rest of
the stroke, taking whole-stroke cost from 22.25 ms to 2.63 ms.

This is also why `Surface` does not set `willReadFrequently`. That flag forces a
software backing store, and this app blits constantly and reads back almost
never. If Chromium logs a suggestion about it during `npm run verify`, that is
the test's own pixel-counting helper, not the app.

---

## Verified, not assumed

`npm run verify` boots the production bundle in real Electron and asserts:

| check | result |
|---|---|
| undo → redo round-trips to the exact pixel | ✓ |
| undo targets the originating layer after switching layers | ✓ |
| stack order — top layer wins | ✓ |
| blend modes apply (multiply of red × green → black) | ✓ |
| hidden layers excluded from the composite | ✓ |
| symmetry mirrors about the document centre | ✓ |
| eraser removes pixels and undoes exactly | ✓ |
| history cost is the bounding box, not the canvas (0.36% of full) | ✓ |
| pen-down 0.01 ms · pen-up 0.33 ms · stroke 2.63 ms | ✓ |

`npm run gestures` drives real PointerEvents through `input.ts` and asserts the
drag gestures: brush resize is zoom-independent (identical at 0.25×, 1×, 4×),
ignores vertical travel, anchors its preview where the drag began, and neither
paints nor pans; scrubby zoom holds the grab point with zero drift; space alone
still pans; a window blur clears stuck modifiers.

**Brush resize uses a ratio mapping** (~2.7× per 100 px, full 1–400 range in a
599 px sweep), not Photoshop's screen-relative one. Screen-relative divides by
camera scale, so the throw length swings with zoom — measured here, a 110 px
drag at 49% zoom covered the entire range, while at 800% you cannot reach a
large brush at all. A ratio is scale-free and gives fine control on small
brushes for free.

`Alt` + right-drag reserves vertical travel deliberately — it is unused, and
tested to stay unused.

**Not verified:** real tablet hardware. Everything above uses synthetic pen
events. Driver behaviour — Wacom vs Windows Ink, contact-pressure spikes, palm
rejection under an actual palm — is untested. That is the first thing to check.

See ROADMAP.md for what is next and where each piece slots in.
