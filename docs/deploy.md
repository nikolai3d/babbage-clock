# Deployment

The site is published at **<https://nikolai3d.github.io/babbage-clock/>**.

Deploys are automatic and have no manual step: push to `main`, and if CI is
green the new build is live a couple of minutes later.

## How a deploy happens

Everything runs inside the single `CI` workflow, so ordering is expressed with
`needs:` rather than inferred across workflows.

```
push to main
  │
  ├─ ci   (typecheck → lint → unit tests → build → base-path audit)
  ├─ e2e  (Playwright + screenshots, in the pinned container)
  │
  └─ deploy   ← needs: [ci, e2e]   +   only on push to main
       ├─ build    vite build with base=/babbage-clock/, audit, payload report
       ├─ publish  upload-pages-artifact → deploy-pages
       └─ smoke    boot.spec.ts against the LIVE url
```

`.github/workflows/ci.yml` holds the gate; `.github/workflows/deploy.yml` is a
reusable workflow holding everything host-specific.

### The gate

Two conditions, both in `ci.yml`:

- `needs: [ci, e2e]` — if either job fails or is cancelled, `deploy` is skipped.
  A red CI cannot publish; there is no code path from a failing test to a live
  site.
- `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` — pull
  requests never match, so a fork PR can neither publish nor obtain the
  `pages: write` / `id-token: write` token. PRs still run `ci` and `e2e` in
  full; they just stop there.

`publish` is serialised on a `pages-deploy-<repo>` concurrency group with
`cancel-in-progress: false` — the opposite of the CI-wide setting. Cancelling a
half-finished publish is how a site ends up serving a partial artifact, so
overlapping deploys queue instead of racing.

Note how that interacts with `ci.yml`'s own `cancel-in-progress: true`: two
pushes to `main` in quick succession cancel the _older whole run_, deploy job
included, and the newer commit wins. That is the behaviour you want for pushes.
The `publish` group is what protects the case the CI-level rule does not — a
rollback re-run of an old commit overlapping a fresh push, since those are
separate workflow runs and neither cancels the other.

### The smoke test is the acceptance test

A workflow file that _looks_ right proves nothing. After `deploy-pages`
reports success, the `smoke` job polls the published URL until it answers 200
(the CDN can serve a stale copy for a few seconds after a deployment is
accepted), then runs `e2e/boot.spec.ts` against the real URL with
`E2E_BASE_URL` set — see `playwright.smoke.config.ts`.

That spec is the right one because it already asserts both halves of "the
deploy worked":

- **no own-origin response ≥ 400** — i.e. no base-path 404s;
- **a real WebGL2 context, `drawCalls > 0`, a non-empty countdown** — i.e. the
  scene genuinely initialised, rather than the page loading and painting
  nothing.

If it fails, the workflow run goes red. Note the ordering consequence: the
artifact is already published at that point, so a failed smoke means _the live
site is broken and you must roll back_, not that publishing was prevented.

The screenshot specs deliberately do **not** run against the live site. Their
baselines are Linux/SwiftShader images pinned to the Playwright container (see
[testing.md](testing.md)); comparing them with a CDN-served page would fail on
pixel noise without adding signal.

## Rolling back

Pages serves whatever the most recent successful `deploy-pages` published, so a
rollback is a re-publish of an older commit — no revert commit required.

1. Open **Actions → CI** and find the last run whose `deploy` job was green.
2. **Re-run jobs → Re-run all jobs**.

The re-run checks out that run's commit, rebuilds it, and publishes it. Within a
couple of minutes the site is back to that state, and the smoke job confirms it.

Then fix forward on `main` at your leisure — the next green push supersedes the
rollback.

To check what is currently live:

```bash
gh api repos/nikolai3d/babbage-clock/pages/deployments | head
curl -sI https://nikolai3d.github.io/babbage-clock/
```

## The base-path gotcha

This is the classic way a Pages deploy ships broken, so it has two independent
guards.

GitHub Pages serves this repository as a **project page**: the site root is
`/babbage-clock/`, not `/`. Locally, `vite preview` serves from `/`. So a URL
written as `/assets/env.hdr` works on every developer machine, passes the whole
e2e suite, and 404s in production only.

`vite.config.ts` reads the base from `VITE_BASE_PATH`, defaulting to `./`:

- **default (`./`)** — relative, so `npm run preview`, the e2e container and any
  root-hosted provider all work with no configuration;
- **deploy workflow** — sets `VITE_BASE_PATH=/babbage-clock/`.

Vite rewrites every URL it can see, and content-hashes the file it points at:
ES imports, dynamic `import()`, `new URL(..., import.meta.url)`, CSS `url()`,
and the `<script>`/`<link>` tags in `index.html`.

**It cannot see a URL that is only assembled at runtime.** `fetch('/assets/x')`
is just a string to the bundler. So:

```ts
// ✗ 404s on the deployed site
const hdr = await load('/assets/ibl/studio.hdr');

// ✓ bundler-owned: rewritten under the base AND content-hashed
const hdr = await load(new URL('../../assets/ibl/studio.hdr', import.meta.url).href);

// ✓ acceptable when the path is genuinely dynamic
const hdr = await load(`${import.meta.env.BASE_URL}ibl/${preset}.hdr`);
```

Note the `BASE_URL` form has no hash in the filename, so it is served with a
short cache lifetime and must be treated as a mutable URL. Prefer the
`import.meta.url` form.

The guards:

1. **`npm run check:base`** (`scripts/check-base-path.mjs`) runs as the last
   step of `npm run ci` and again in the deploy build. It scans `dist/` for
   root-absolute asset URLs that bypass the base and fails with the file, line
   and offending URL. This catches assets behind a lazy path that no test
   happens to request.
2. **The live smoke run**, which catches anything a real boot requests.

There is no SPA `404.html`: the app has no client-side routing, it reads only
query parameters (`?scene=`, `?target=`, `?tz=`), and every one of those is
served by `index.html` at the site root. Adding a rewrite would only mask real
404s from the boot spec. If routing is ever introduced, that is the moment to
add one.

## Payload budget

Measured on the deployed build (`VITE_BASE_PATH=/babbage-clock/ npm run build`,
then `node scripts/report-payload.mjs`):

| First-load asset | Raw        | Gzipped    | Hashed |
| ---------------- | ---------- | ---------- | ------ |
| `index.html`     | 3.0 kB     | 1.3 kB     | n/a    |
| `index-*.js`     | 671.0 kB   | 183.0 kB   | yes    |
| `index-*.css`    | 12.0 kB    | 3.6 kB     | yes    |
| **Total**        | **686 kB** | **188 kB** | —      |

The deploy step summary carries the current numbers for every run; the table
above is a checkpoint, not a source of truth.

Nearly all of it is three.js plus `temporal-polyfill`, in one chunk.

**Budget: 250 kB gzipped on the first-load path.** Crossing it means a new
runtime dependency landed in the entry chunk; the fix is to split or lazy-load
it, not to raise the number.

Notes on what is and is not counted:

- **Source maps (~3.5 MB) are excluded and are not a payload problem.** They are
  shipped deliberately, and browsers fetch them only with devtools open.
- **Hashed filenames, but not long-lived caching — and that is GitHub's call,
  not ours.** Vite emits `assets/index-<hash>.{js,css}`, so the URLs are safe to
  cache forever. Pages does not: measured on the live site, it serves _every_
  file — hashed assets included — with `cache-control: max-age=600`, and the
  header is not configurable. So a returning visitor revalidates after ten
  minutes rather than getting a free hit.

  The hashing is still doing real work: it makes a deploy atomic from the
  browser's point of view (new bundle, new URL, no chance of a stale script
  paired with fresh HTML) and it is what a CDN in front of Pages, or a move to
  Netlify/Vercel/CloudFront, would immediately exploit. Treat this as a known
  ceiling of the current host, not as something to work around.

- **Heavy assets must be lazy.** As of this deploy there are none — the clock is
  fully procedural (see [assets.md](assets.md)), so the report shows no deferred
  files. HDR environment maps and any future texture set must be reached through
  a dynamic `import()` or a loader call _after_ first paint, so the entry chunk
  never grows with them. `scripts/report-payload.mjs` lists first-load and
  deferred assets separately precisely so a regression here is visible in the
  deploy step summary.
- The loading screen is authored in `index.html` and paints before the module
  graph loads, so perceived first paint does not wait on the 184 kB.

## Moving to another host

The gate, the build, the base-path audit and the live smoke test are all
host-agnostic. Switching to Netlify, Vercel or S3+CloudFront means:

1. replacing the three steps in `deploy.yml`'s `publish` job with that
   provider's action, exposing the deployed URL as the `page-url` job output;
2. passing `base-path: /` from `ci.yml` if the new host serves from a domain
   root.

`ci.yml`, the smoke job, `check-base-path.mjs` and `report-payload.mjs` are
unchanged. That split is why `deploy.yml` is a reusable workflow rather than
inline jobs.
