# Timing

`src/time/` answers two questions, independently of each other and of anything
that renders:

1. **What instant are we counting down to?** (`target.ts`) — a wall-clock time
   plus a timezone, resolved through the real IANA tz database.
2. **What time is it, really?** (`trueTime.ts`) — the device clock is not
   trusted for absolute time, so it is checked against the network.

Nothing under `src/time/` imports three.js or touches the DOM directly. `fetch`,
timers, tab visibility and both clocks are injectable seams, which is why the
whole module unit-tests in plain Node with no network and no WebGL context.

Import from the barrel: `import { trueNow, resolveTarget } from './time/index.js'`.

---

## Part 1 — Timezone-aware targets

### Why Temporal

`temporal-polyfill` (~40 kB gzipped, spec-accurate implementation of the
TC39 Temporal proposal). Chosen over Luxon and over hand-rolled offset maths:

- **Explicit disambiguation.** Temporal makes the DST gap/overlap decision part
  of the API (`disambiguation: 'compatible' | 'earlier' | 'later' | 'reject'`).
  The product needs both behaviours and needs to know which one fired; with
  Luxon the same information has to be reverse-engineered from the result.
- **No native support to wait for.** Node 24 does not ship Temporal and neither
  do current browsers, so a polyfill is required either way. When engines do
  ship it, the import is the only thing that changes.
- **Nothing hand-rolled.** Offsets are never computed here, and a zone-less
  string is never handed to `Date`, because `new Date('2026-03-08T02:30:00')`
  silently produces the wrong instant in a spring-forward gap.

`Date` is still used for the _epoch milliseconds_ the rest of the app speaks —
Temporal is confined to the conversion.

### Accepted input

| Input                                     | Interpreted as                                  |
| ----------------------------------------- | ----------------------------------------------- |
| `2026-12-31T23:59:59`                     | wall clock in `zone` (viewer's zone if omitted) |
| `2026-12-31 23:59`                        | same; the space separator is accepted           |
| `2026-12-31`                              | midnight that day in `zone`                     |
| `2026-12-31T23:59:59Z`                    | absolute instant; `zone` used only for display  |
| `2026-12-31T23:59:59+05:30`               | absolute instant                                |
| `2026-12-31T23:59:59+01:00[Europe/Paris]` | absolute instant; zone taken from the string    |

`zone` accepts an IANA id (`America/New_York`), a fixed offset (`+05:30`),
`UTC`, or `local`/omitted for the viewer's zone.

### URL parameters

```
?target=2026-12-31T23:59:59&tz=Europe/Paris
```

Any countdown is therefore a shareable link, and it means the same instant to
every recipient regardless of where they are. `?target=` without `?tz=` is read
in the _viewer's_ zone, which is what a viewer typing a local time expects.

With no `?target=` at all the app counts down to **the next New Year in the
viewer's timezone** — an owner decision, so that the landing page always shows a
live countdown. `resolveTargetFromParams` never throws: unparseable input falls
back to that default with an explanation in `notes`.

### DST edge cases

Resolution uses `disambiguation: 'compatible'`, which is exactly the two
behaviours wanted, and the outcome is reported rather than hidden:

| Case                                                                  | Behaviour                          | `disambiguation`    |
| --------------------------------------------------------------------- | ---------------------------------- | ------------------- |
| **Gap** — 02:30 on 8 Mar 2026 in `America/New_York` never happens     | resolved forward to 03:30 `-04:00` | `gap-forward`       |
| **Overlap** — 01:30 on 1 Nov 2026 in `America/New_York` happens twice | the **earlier** instant, `-04:00`  | `ambiguous-earlier` |
| Ordinary time                                                         | unchanged                          | `none`              |

In both adjusted cases `requestedWallClock` holds the time as typed and `notes`
carries a sentence fit for display ("02:30 does not exist in America/New_York
(daylight-saving gap) — using 03:30 -04:00").

Once resolved, a target is an instant. A viewer in Tokyo and a viewer in Denver
looking at the same link see the same countdown, ticking to zero simultaneously.

### Echoes and validation

Every `ResolvedTarget` carries the instant rendered **twice** — in the entered
zone and in the viewer's zone — so a mistyped zone is visible rather than
silently three hours out:

```
enteredZone: 2027-01-01 00:00:00 +09:00 (Asia/Tokyo)
viewerZone:  2026-12-31 10:00:00 -05:00 (America/New_York)
```

Echo strings are built from Temporal fields, not `toLocaleString`: the readout
must be identical in CI, in tests and in every browser locale.

A target already in the past is **not** an error — it comes back with
`expired: true` and a note, so a shared link to a passed event still renders.

### Display clamp

The rings read `HHH:MM:SS`, so `computeRemaining` pins at **999:59:59** and sets
`clamped: true` while the real remainder is larger (`rawTotalSeconds` keeps the
true value). Hours run past 24 rather than rolling into a days field. Expiry is
decided on the millisecond, not the floored second, so 300 ms remaining reads
`000:00:00` but is not yet `expired`.

---

## Part 2 — Trusted current time

### The problem

A device clock that is three minutes fast makes the rings hit zero three minutes
early. But `performance.now()` _is_ trustworthy for elapsed time: it is
monotonic and unaffected by NTP steps, DST, or the user dragging the system
clock. So:

```
trueNow() = syncedEpoch + (performance.now() - syncMark)
```

`Date.now()` is read only at sync points, never for progression.

### Offset estimation (NTP-lite)

Per sample, timestamped with the monotonic clock either side of the request:

```
rtt          = monotonic_after - monotonic_before
clientMidpoint = deviceClock_before + rtt / 2
offset       = serverTime - clientMidpoint
```

Assuming symmetric latency, the server read its clock at the midpoint of the
round trip, so the midpoint is the client instant to compare it against.

Five samples are taken per provider. Samples whose RTT exceeds 1.5× the median
RTT are discarded — a slow round trip is asymmetric far more often than not,
which biases the estimate even when the arithmetic is right — and the **median**
of what remains is used, because one stalled request wrecks a mean and does
nothing to a median. Reported uncertainty is `bestRtt / 2 + resolution / 2`.

### Fallback chain

Each step returns UTC; the first one that yields at least two usable samples
wins.

| #   | Source                                                  | Tier           | Notes                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `timeapi.io/api/Time/current/zone?timeZone=UTC`         | `ntp-lite`     | Sends `Access-Control-Allow-Origin: *` (verified). Sub-second precision. Free service, no uptime guarantee. Returns a zone-less wall clock — we request UTC and append `Z` rather than letting the platform guess.                                                       |
| 2   | `cloudflare.com/cdn-cgi/trace`                          | `ntp-lite`     | Different operator, different failure mode. `access-control-allow-origin: *` (verified), `ts=` line carries fractional epoch seconds, served from the nearest edge. Not a documented time API, so a shape change just falls through.                                     |
| 3   | `Date` header of a HEAD request to the app's own origin | `http-date`    | `Date` is CORS-safelisted, so this works against any HTTPS origin; same-origin means no third party need be up. One-second resolution, so 500 ms is added to centre the estimate in `[value, value+1s)`. Cache-busted, or a replayed response would supply a stale time. |
| 4   | Device clock                                            | `device-clock` | `degraded: true`. The countdown keeps running — **never a blank screen**.                                                                                                                                                                                                |

**worldtimeapi.org was evaluated and rejected**: it failed its TLS handshake
outright during development, which matches its reputation for 503s and rate
limits. It is a reasonable drop-in for step 1 or 2 if timeapi.io degrades —
`TrueTimeOptions.providers` takes any list.

Accuracy expectations: `ntp-lite` typically lands within a few tens of
milliseconds (bounded by half the round trip); `http-date` within roughly a
second; `device-clock` is whatever the device believes, commonly good to a few
seconds and occasionally minutes or hours out.

### Re-sync, slew and step

Re-syncs fire on `visibilitychange` back to visible (tab-sleep recovery) and
every 45 minutes. Visibility-driven re-syncs are rate-limited to one a minute so
flicking between tabs cannot hammer the API, and overlapping calls coalesce into
one run.

A new estimate is applied as:

- **Slew** when the correction is ≤ 2 s: bled in at 5 % of elapsed time, so a
  400 ms correction takes ~8 s and is imperceptible. The rate stays below 1
  deliberately — even a _backwards_ correction leaves the reported time strictly
  increasing, so the rings never tick backwards.
- **Step** when it is larger: pretending a ten-minute error away slowly is worse
  than one honest jump.

### What the UI should surface

`TrueTimeStatus` is pushed into the app store as `timeStatus` on every change.
Suggested treatment (the timezone-picker and HUD beads own the actual pixels):

| Condition           | Suggested treatment                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tier: 'ntp-lite'`  | nothing, or a quiet "synced" dot. This is the normal case.                                                                                                    |
| `tier: 'http-date'` | quiet indicator: accurate to about a second.                                                                                                                  |
| `degraded: true`    | visible but non-blocking: "device clock — may be inaccurate".                                                                                                 |
| `skewWarning: true` | warn: the device clock is off by more than 5 s (`offsetMs` says by how much and which way). Worth telling the viewer, since their other clocks are wrong too. |

`lastSyncMs`, `sampleCount` and `uncertaintyMs` are there for a diagnostics
panel.

---

## API reference

### Targets — `src/time/target.ts`

```ts
interface TimeSource {
  now(): number;
} // the injection seam
const systemTimeSource: TimeSource; // uncorrected device clock

function resolveTarget(input: TargetInput): ResolvedTarget; // throws TargetError
function resolveTargetFromParams(
  params: { target: string | null | undefined; tz?: string | null | undefined },
  nowMs: number,
  viewerZone?: string,
): ResolvedTarget; // never throws
function defaultTarget(nowMs: number, viewerZone?: string): ResolvedTarget;
function nextNewYearZoned(nowMs: number, zone?: string): Temporal.ZonedDateTime;
function nextNewYear(nowMs: number): Date;
function parseTargetParam(raw, zone?): Date | null;
function resolveCountdownTarget(raw, nowMs, tzParam?): ResolvedTarget;
function viewerTimeZone(): string;
function isValidTimeZone(zone: string | null | undefined): boolean;

interface TargetInput {
  value: string; // wall clock or ISO instant
  zone?: string; // IANA id, fixed offset, 'local', or omitted
  label?: string;
  source?: 'url' | 'default-new-year' | 'input';
  nowMs?: number;
  viewerZone?: string;
}

interface ResolvedTarget {
  label: string;
  atMs: number; // the instant
  source: 'url' | 'default-new-year' | 'input';
  zone: string; // zone it was entered in
  enteredZone: ZoneEcho;
  viewerZone: ZoneEcho;
  disambiguation: 'none' | 'gap-forward' | 'ambiguous-earlier';
  requestedWallClock: string | null; // as typed, when adjusted
  expired: boolean;
  notes: readonly string[]; // displayable sentences
}

interface ZoneEcho {
  zone: string;
  wallClock: string;
  offset: string;
  formatted: string;
}
class TargetError extends Error {
  code: 'invalid-date-time' | 'invalid-zone';
}
```

### Trusted time — `src/time/trueTime.ts`

```ts
function initTrueTime(options?: TrueTimeOptions): Promise<TrueTimeStatus>; // never rejects
function trueNow(): number; // corrected UTC epoch ms
function getTimeStatus(): TrueTimeStatus;
function subscribeTimeStatus(fn: (s: TrueTimeStatus) => void): () => void;
function getTrueTimeClock(options?: TrueTimeOptions): TrueTimeClock;
function disposeTrueTime(): void;
const trueTimeSource: TimeSource; // what main.ts injects

function getRemaining(targetEpochMs: number, nowMs?: number): RemainingTime;
function estimateOffset(samples, resolutionMs?): OffsetEstimate | null;

class TrueTimeClock implements TimeSource {
  now(): number;
  init(): Promise<TrueTimeStatus>;
  sync(): Promise<TrueTimeStatus>;
  getStatus(): TrueTimeStatus;
  subscribe(fn: (s: TrueTimeStatus) => void): () => void;
  dispose(): void;
}

interface TrueTimeStatus {
  tier: 'ntp-lite' | 'http-date' | 'device-clock';
  sourceId: string | null;
  offsetMs: number; // trueTime - Date.now()
  uncertaintyMs: number;
  lastSyncMs: number | null;
  sampleCount: number;
  synced: boolean;
  skewWarning: boolean; // |offsetMs| > 5000
  degraded: boolean; // running on the device clock
}
```

`TrueTimeClock` satisfies `TimeSource`, so the renderer takes it as a drop-in
and `main.ts` injects it in one line. Tests construct `TrueTimeClock` directly
rather than using the shared singleton, so they never share state.

### Countdown maths — `src/time/countdown.ts`

```ts
function computeRemaining(targetEpochMs: number, nowMs: number): RemainingTime;
function formatRemaining(remaining: RemainingTime): string; // 'HHH:MM:SS'
const MAX_DISPLAY_HOURS = 999;
const MAX_DISPLAY_SECONDS; // 999:59:59

interface RemainingTime {
  totalSeconds: number; // clamped, never negative
  rawTotalSeconds: number; // unclamped; negative once passed
  hours: number; // 0…999
  minutes: number;
  seconds: number;
  clamped: boolean;
  expired: boolean;
}
```

`computeCountdown` / `countdownDigits` / `clockDigits` are unchanged from the
scaffold and still drive the rings.
