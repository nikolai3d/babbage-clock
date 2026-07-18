# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm install
npm run dev        # Vite dev server on http://localhost:5173
npm run ci         # typecheck -> lint -> test -> build; run this before opening a PR
```

Individual gates: `npm run typecheck`, `npm run lint`, `npm run test` (Vitest,
single run — never use watch mode in an agent session), `npm run build`.

Browser tests (Playwright) are a separate layer and a separate CI job:

```bash
npm run test:e2e                    # e2e + screenshots, always --reporter=line
npm run test:e2e:docker             # exactly as CI runs it (needs Docker)
npm run test:e2e:docker:update      # regenerate screenshot baselines
```

**If you change how the scene looks — geometry, materials, lighting, camera, or
the HUD — the screenshot baselines will fail. That is the point.** Regenerate
them with `npm run test:e2e:docker:update`, then *look at the new PNGs* before
committing. Do not raise the diff tolerance to make a failure go away.

Baselines are Linux/SwiftShader images and are only comparable when produced in
the Playwright container, which is why the screenshot specs skip on macOS.
Never pass Playwright's default `html` reporter in an agent session: it starts a
server on failure and hangs the command. Full details: **[docs/testing.md](docs/testing.md)**.

## Architecture Overview

Vanilla TypeScript + three.js (WebGL2), no UI framework. How a clock looks —
ring count and layout, materials, lighting, camera framing — is data in a
`SceneDefinition` held in a scene registry, switchable at runtime and via
`?scene=`. Read **[docs/architecture.md](docs/architecture.md)** before changing
rendering, scenes, materials or lighting; it documents the module layout and the
typed extension points for PBR materials, IBL presets and NTP time.

## Conventions & Patterns

- `src/scene/`, `src/time/` and `src/geometry/` must not import three.js — that
  is what keeps them unit-testable without a WebGL context. Geometry maths
  (tooth profiles, glyph outlines, digit angles) lives in `src/geometry/`;
  `src/render/geometry/` is the only place it becomes a `BufferGeometry`.
  Conventions and budgets: `docs/assets.md`.
- `src/ui/` must not import three.js either. UI reads the app store and emits
  intents; `main.ts` wires them to the renderer.
- Anything `ClockSceneView` creates must be disposed: register geometries with
  `this.track(...)` and take materials from the `MaterialLibrary`. Scenes are
  swapped repeatedly at runtime, so leaks compound.
- Prefer typed extension points over `TODO` comments.
- WebGL2 via the classic `WebGLRenderer`. WebGPU is deferred — do not introduce
  `WebGPURenderer`.
