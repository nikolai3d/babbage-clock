# babbage-clock

A web-based 3D HTML clock / countdown — spinning gear mechanisms rendered with
three.js (WebGL2) and vanilla TypeScript.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

## Scripts

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Vite dev server with HMR                       |
| `npm run build`     | Production build into `dist/`                  |
| `npm run preview`   | Serve the production build locally             |
| `npm run lint`      | ESLint + Prettier check                        |
| `npm run typecheck` | `tsc --noEmit`                                 |
| `npm run test`      | Vitest, single run                             |
| `npm run ci`        | typecheck → lint → test → build (what CI runs) |

## URL parameters

| Parameter | Example                       | Default                            |
| --------- | ----------------------------- | ---------------------------------- |
| `scene`   | `?scene=slate-orrery`         | `copper-padlock`                   |
| `target`  | `?target=2030-01-01T00:00:00` | next New Year in the viewer's zone |

An unknown `scene` or an unparseable `target` falls back to the default rather
than erroring.

## Architecture

Everything about how a clock looks — ring count and layout, materials, lighting,
camera framing — is data in a `SceneDefinition`, registered in a scene registry
and switchable at runtime. See [docs/architecture.md](docs/architecture.md) for
the module layout, the extension points for materials / IBL / NTP, and how to
add a new scene.

## Task tracking

Issues are tracked with [beads](https://github.com/steveyegge/beads) (`bd`),
backed by a Dolt database in `.beads/`. Sync happens via the Dolt remote
(`bd sync`), not via git hooks — the database itself is not committed to git.
