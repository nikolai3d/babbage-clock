# babbage-clock

[![CI](https://github.com/nikolai3d/babbage-clock/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nikolai3d/babbage-clock/actions/workflows/ci.yml)

A web-based 3D HTML clock / countdown — spinning gear mechanisms rendered with
three.js (WebGL2) and vanilla TypeScript.

**Live: <https://nikolai3d.github.io/babbage-clock/>**

Every green push to `main` publishes automatically, and the deploy is verified
by booting the live site. See [docs/deploy.md](docs/deploy.md).

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

## Scripts

| Script                  | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run dev`           | Vite dev server with HMR                                         |
| `npm run build`         | Production build into `dist/`                                    |
| `npm run preview`       | Serve the production build locally                               |
| `npm run lint`          | ESLint + Prettier check                                          |
| `npm run typecheck`     | `tsc --noEmit`                                                   |
| `npm run test`          | Vitest, single run                                               |
| `npm run ci`            | typecheck → lint → test → build → base-path audit (what CI runs) |
| `npm run test:e2e`      | Playwright end-to-end + screenshot tests                         |
| `npm run test:e2e:live` | Boot spec against a deployed site (`E2E_BASE_URL=…`)             |
| `npm run capture:demo`  | Record a demo video tour into `artifacts/`                       |

Screenshot baselines are Linux/SwiftShader images regenerated with
`npm run test:e2e:docker:update`. See [docs/testing.md](docs/testing.md).

## URL parameters

| Parameter | Example                       | Default                            |
| --------- | ----------------------------- | ---------------------------------- |
| `scene`   | `?scene=slate-orrery`         | `copper-padlock`                   |
| `target`  | `?target=2030-01-01T00:00:00` | next New Year in the viewer's zone |
| `tz`      | `?tz=Europe/Paris`            | the viewer's own timezone          |
| `mood`    | `?mood=night`                 | the scene's own lighting           |
| `bg`      | `?bg=backdrop`                | automatic (quality tier decides)   |

`target` is a wall clock read in `tz` (an IANA id, a fixed offset like `+05:30`,
or the viewer's zone if omitted), or a full ISO 8601 instant carrying its own
offset — `?target=2026-12-31T23:59:59Z` means the same instant everywhere. Any
countdown is therefore a shareable link.

An unknown `scene` or an unparseable `target` falls back to the default rather
than erroring.

There are also test-only parameters — `mockNow`, `mockNowMode`, `nomotion` and
`testApi` — used by the e2e suite and the demo capture. Each is inert unless
explicitly set; see [docs/testing.md](docs/testing.md#determinism-hooks).
`?nomotion` freezes every moving part — the tick easing, the gear train, the
balance wheel and the detents — without changing what the rings read.

## Architecture

Everything about how a clock looks — ring count and layout, materials, lighting,
camera framing — is data in a `SceneDefinition`, registered in a scene registry
and switchable at runtime. See [docs/architecture.md](docs/architecture.md) for
the module layout, the remaining extension points, and how to add a new scene.

Surfaces are PBR materials loaded from texture folders: drop a Substance 3D
Sampler export into `public/assets/materials/<name>/` with a `material.json`
beside it and name it from a scene's material slots — no code changes. Slots can
also be re-bound at runtime from the settings panel. See
[docs/materials.md](docs/materials.md) for the schema, the exact Sampler export
settings, the texel-density convention and the KTX2 path.

The countdown runs on a network-corrected clock rather than the device clock,
and targets resolve through the real IANA timezone database. See
[docs/timing.md](docs/timing.md).

The rings tick like an escapement rather than sliding, and a carry cascade —
`100:00:00` becoming `099:59:59` — turns every affected ring as one coordinated
event. That state machine is three.js-free and unit-tested on its own; see
[docs/mechanism.md](docs/mechanism.md).

The countdown is readable without sight, without a mouse and without a GPU: a
throttled live region mirrors it as words, `prefers-reduced-motion` and
`?nomotion=1` share one switch, and a failed or lost WebGL context falls back to
a text clock driven by the same timing module. See
[docs/accessibility.md](docs/accessibility.md).

## Task tracking

Issues are tracked with [beads](https://github.com/steveyegge/beads) (`bd`),
backed by a Dolt database in `.beads/`. Sync happens via the Dolt remote
(`bd sync`), not via git hooks — the database itself is not committed to git.
