# Accessibility and fallbacks

A WebGL countdown has two problems that no amount of polish on the canvas
solves: assistive technology cannot read a canvas, and a machine without a
working GL stack cannot draw one. The site's promise is an accurate countdown,
so the countdown has to survive both.

Four things carry that promise:

| Concern          | Where it lives                                          |
| ---------------- | ------------------------------------------------------- |
| Text mirror      | `src/ui/countdownAnnouncer.ts`, `countdownSpeech.ts`    |
| Motion           | `src/app/motion.ts`                                     |
| No GPU           | `src/ui/fallbackClock.ts`, `src/app/countdownTicker.ts` |
| Automated checks | `e2e/a11y.spec.ts`, `e2e/fallback.spec.ts`              |

---

## The countdown as text

### Why there are two elements, and only one is live

`#countdown` in the HUD carries `role="timer"` and changes four times a second.
`role="timer"` is an **implicit live region**: left alone, a screen reader would
recite the clock forever and the page would be unusable. It is therefore pinned
to `aria-live="off"`, and the announcements come from a second, visually hidden
element:

```
p#countdown-announcement.sr-only[aria-live=polite][aria-atomic=true]
```

Exactly one of the two is live. That is the reconciliation — not two live
regions racing, and not a `role="timer"` that also announces.

`aria-atomic="true"` matters: without it a screen reader may read only the words
that changed ("twelve") rather than the whole sentence, which is meaningless out
of context.

### Cadence

The announcement text is a pure function of `RemainingTime`, and so is the
decision about **when** to speak it. `announcementKey()` maps a remaining time to
the announcement slot it belongs to; the announcer speaks only when the slot
changes. The store's push rate is therefore irrelevant.

| Remaining        | Slot changes    | Announcements                         |
| ---------------- | --------------- | ------------------------------------- |
| over 999 hours   | never           | one, "More than 999 hours remaining." |
| over 60 s        | on every minute | one per minute                        |
| 60 s, 30 s, 10 s | at each         | one each                              |
| expired          | once            | "Time is up."                         |

Plus one on load, and one whenever the viewer changes the target — both of those
name the target, so a duration is never orphaned from what it counts down to
("Counting down to New Year's Day 2027. 41 hours, 12 minutes remaining.").

Phrasing is words, not `HHH:MM:SS`: a screen reader reads the latter as "zero
zero one colon zero four colon…". Seconds appear only under an hour, where they
are the figure that matters.

After expiry the announcer goes quiet. The HUD counts up from there, but
narrating an elapsed timer forever is the same mistake as narrating a live one.

### Testing it by ear

The automated checks prove the region exists, is polite and atomic, and does not
follow the readout. They cannot prove it _sounds_ right. Do this before changing
the phrasing:

**macOS / VoiceOver**

1. `npm run dev`, then `Cmd-F5` to start VoiceOver.
2. Load `http://localhost:5173/?target=<something ~90 seconds out>`.
3. On load you should hear the target and the remaining time once.
4. Wait. You should hear an update at the minute, then at 60, 30 and 10 seconds,
   then "Time is up." **You should not hear the seconds counting.**
5. `VO-U` then the "Landmarks/Static text" rotor is a quick way to confirm the
   canvas is announced as an image with a name, not as an empty graphic.

**Windows / NVDA** is the same script; use `Insert-Down` to read the page.

A good smoke test for the throttle is simply to leave the tab focused for two
minutes and count what you hear. Three announcements is right; a hundred and
twenty is the bug this design exists to prevent.

---

## Motion

There is **one** motion switch, and it lives in `src/app/motion.ts`:

```
effective motion = (no ?nomotion=1) AND (not prefers-reduced-motion: reduce)
```

`MotionPreference` combines the two, watches the media query for a mid-session
change, and hands a single boolean to `ClockRenderer`, which passes it to
`ClockSceneView` and on to `Mechanism`. Nothing downstream reads the media query
or the query parameter on its own. **If you need motion state somewhere new,
take it from here rather than adding a second check.**

With motion off:

- idle camera drift and OrbitControls damping stop;
- the gear train, balance wheel and detent levers freeze;
- ring ticks snap instantly — no easing, no overshoot;
- CSS transitions and the loading-screen gears are neutralised by the
  `prefers-reduced-motion` block in `styles.css`.

The countdown itself is untouched: it is a function of the instant, not of an
animation, so it stays exactly as correct as it was. `e2e/a11y.spec.ts` asserts
that the readout keeps advancing with motion off.

`?nomotion=1` still wins over the media query in both directions, so a
deterministic screenshot never depends on the host's accessibility settings.

Changing the preference while the page is open rebuilds the scene view (the
mechanism takes its motion setting at construction). The camera is not touched,
so an orbit in progress survives.

---

## Keyboard

Everything is a real element — `<button>`, `<label>`, `<input>`, `<form>`,
`<select>` — so the keyboard behaviour is mostly the platform's. What is ours:

- **The canvas is one tab stop.** It has `role="img"`, a name, and
  `tabindex="0"`, and the arrow keys orbit it, `+`/`-` zoom, `Home` (or `R`)
  resets the view — implemented in `ClockRenderer`, obeying the same camera
  limits the pointer path obeys. Nothing traps focus there; Tab moves on to the
  settings button. Skipping the view costs one Tab, and the countdown is
  available as text regardless, so no one has to use it.
- **The drawer moves focus in both directions.** Opening it focuses the first
  field; closing it (button, or `Escape`) returns focus to the toggle, so a
  keyboard user is never stranded behind a closed panel.
- **The timezone combobox** is the ARIA 1.2 pattern on real elements:
  `input[role=combobox][aria-expanded][aria-controls]` over a
  `ul[role=listbox]`, arrow keys to navigate, `aria-activedescendant` for the
  active option, `Enter` to commit, `Escape` to revert. Tab always leaves.
  `Escape` is marked handled there so it closes the listbox rather than the
  whole drawer.
- **Focus is always visible.** The ring is two-tone (see below).

`e2e/a11y.spec.ts` walks the entire flow — open the drawer, fill the date, pick a
zone, apply, switch scene, switch lighting mood, copy the share link, close —
using nothing but `Tab`, arrows, letters and `Enter`.

---

## Contrast and zoom

The 2D chrome floats over an image-based backdrop that scenes and lighting moods
are free to change, so its contrast cannot be reasoned about against the dark
canvas it happens to sit on today. **Every chrome background is opaque enough
that the worst case — a blown-out white backdrop behind it — still clears WCAG AA
for the text on it.**

Two real failures were fixed by that rule:

| Element                       | Before (over white) | After |
| ----------------------------- | ------------------- | ----- |
| `.status--quiet` text         | 1.5:1               | 5.0:1 |
| `.hud__settings-toggle` label | 1.2:1               | 6.9:1 |

The status strip said "nothing to see here" with `opacity: 0.6`, which fades the
text along with everything else; it now says it with colour. The settings toggle
was a brass tint at 22% over a 88%-opaque base; it is now the same tint over an
opaque one, which looks the same on the dark scene and survives a bright one.

Focus rings get the same treatment from the other direction: a single light ring
vanishes on a pale backdrop and a single dark one vanishes on a dark scene, so
the ring is a brass outline with a dark `box-shadow` halo behind it. Box shadows
paint under outlines, so whichever way the backdrop goes, one of the two has
contrast against it.

**Zoom**: at 200% the CSS viewport halves, which puts the layout into the narrow
branch — the drawer becomes a bottom sheet that scrolls inside itself rather than
growing past the viewport. `e2e/a11y.spec.ts` checks a 640×360 viewport for
horizontal overflow, a drawer that fits, and no axe violations.

---

## No WebGL, and lost contexts

Two failures, one view.

**Context creation fails.** `new THREE.WebGLRenderer()` throws — an old browser,
hardware acceleration switched off, a policy that blocks WebGL, a headless
environment. `main.ts` catches it, hides the canvas, and shows `FallbackClock`.

**The context is lost mid-session.** `webglcontextlost` fires. On iOS this is
routine: backgrounding the tab, memory pressure, a second WebGL page. The frame
loop stops and the same fallback appears, because **a canvas frozen on a stale
frame is worse than no canvas — it shows the wrong time convincingly.**

`FallbackClock` imports no three.js. It reads the app store, which
`CountdownTicker` keeps advancing on a 250 ms interval off the same `TimeSource`
the renderer uses — so the fallback cannot drift from what the rings would have
shown. The live region keeps working throughout, because it reads the store too.

On `webglcontextrestored` three.js re-initialises its own GL state and re-uploads
geometry and materials, so the scene graph, the active scene and the viewer's
camera all survive. What the renderer redoes is the part that is a function of
time: the mechanism is seeked to the current instant before the first frame, so
the rings come back reading the right digits rather than the ones they froze on.
If the restore never arrives, the note changes after eight seconds to say so and
the text countdown stays — the countdown is correct either way.

### Reproducing both by hand

No WebGL, in any browser's console before the app loads (or with
`disableWebGL(page)` in a spec):

```js
const original = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
  return type.includes('webgl') ? null : original.call(this, type, ...rest);
};
```

Context loss, from the console of a running page:

```js
const gl = document.querySelector('#scene-canvas').getContext('webgl2');
const ext = gl.getExtension('WEBGL_lose_context'); // keep this handle!
ext.loseContext();
// …the text countdown appears…
ext.restoreContext();
```

Keep the extension handle. Once the context is lost, `getExtension` on it
returns null, so a second lookup can never find `restoreContext`.

Chrome's `chrome://settings` → System → "Use graphics acceleration when
available" is the real-world version of the first test.

---

## Automated checks

`e2e/a11y.spec.ts` runs [axe-core](https://github.com/dequelabs/axe-core) against
the app in each of its states — drawer closed, drawer open, timezone listbox
open, a toast showing, the loading screen, and at 200% zoom — and fails CI on any
violation.

The rule set is `wcag2a, wcag2aa, wcag21a, wcag21aa`. Best-practice rules are
deliberately excluded: they flag defensible opinions ("all content should be
inside a landmark") that are not WCAG, and folding them in would fail the suite
for reasons unrelated to anyone's ability to use the page. If you want to add
them, add them as a separate, non-blocking check.

The loading screen is scanned by blocking the JavaScript bundle, which leaves the
authored markup on screen indefinitely. That is deterministic and it scans
exactly what ships.

**What axe cannot tell you**: whether the announcements make sense, whether the
cadence is bearable, whether the keyboard order is sane, or whether the contrast
holds over an IBL backdrop it cannot see through the canvas. Those are the manual
passes above, and they are worth redoing whenever the lighting or the HUD
changes.
