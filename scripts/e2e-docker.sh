#!/usr/bin/env bash
#
# Runs the e2e suite inside the official Playwright container — the same image
# CI uses — so screenshots are compared against, and regenerated in, exactly the
# environment that produced the committed baselines.
#
#   scripts/e2e-docker.sh                      # run the suite
#   scripts/e2e-docker.sh --update-snapshots   # regenerate the baselines
#   scripts/e2e-docker.sh screenshots.spec.ts  # any playwright CLI arguments
#
# The host's node_modules is deliberately shadowed by a named volume: the
# container installs Linux binaries, and writing those over a macOS developer's
# tree would break their next local run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not running. Start Docker Desktop (or dockerd) and retry." >&2
  exit 1
fi

PLAYWRIGHT_VERSION="$(node -p "require('${ROOT}/node_modules/@playwright/test/package.json').version" 2>/dev/null || true)"
if [ -z "${PLAYWRIGHT_VERSION}" ]; then
  echo "error: could not read the @playwright/test version. Run 'npm ci' first." >&2
  exit 1
fi

IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"
MODULES_VOLUME="babbage-clock-e2e-node-modules"
NPM_CACHE_VOLUME="babbage-clock-e2e-npm-cache"

echo "==> Playwright image: ${IMAGE}"

# Keep host ownership of anything the container writes (baselines, artifacts).
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

# Serialise concurrent runs on the shared node_modules volume.
#
# Two containers mounting "${MODULES_VOLUME}" both run `npm ci`, and the second
# wipes it underneath the first — which then dies with 'Cannot find module
# .../workerProcessEntry.js'. A host-side lock keeps the cache shared (and warm,
# unlike a per-run volume) while making the second run wait its turn rather than
# corrupt the first. `mkdir` is the atomic primitive here because `flock` is not
# available on macOS hosts; the holder records its PID so a lock orphaned by a
# crashed run is reclaimed rather than deadlocking every future run.
LOCK_DIR="${TMPDIR:-/tmp}/${MODULES_VOLUME}.lock"
until mkdir "${LOCK_DIR}" 2>/dev/null; do
  lock_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [ -n "${lock_pid}" ] && ! kill -0 "${lock_pid}" 2>/dev/null; then
    echo "==> reclaiming an e2e volume lock left by a dead run (pid ${lock_pid})" >&2
    rm -rf "${LOCK_DIR}"
    continue
  fi
  echo "==> another e2e run holds ${MODULES_VOLUME}; waiting for it to finish…"
  sleep 3
done
trap 'rm -rf "${LOCK_DIR}"' EXIT
echo "$$" >"${LOCK_DIR}/pid"

docker run --rm --init --ipc=host \
  -v "${ROOT}:/work" \
  -v "${MODULES_VOLUME}:/work/node_modules" \
  -v "${NPM_CACHE_VOLUME}:/root/.npm" \
  -w /work \
  -e CI \
  -e HOST_UID="${HOST_UID}" \
  -e HOST_GID="${HOST_GID}" \
  "${IMAGE}" \
  bash -c '
    set -euo pipefail
    npm ci --no-audit --no-fund
    status=0
    npx playwright test --reporter=line "$@" || status=$?
    # Baselines and artifacts are written as root inside the container; hand
    # them back so the host user can inspect and commit them.
    chown -R "${HOST_UID}:${HOST_GID}" e2e artifacts test-results 2>/dev/null || true
    exit $status
  ' bash "$@"
