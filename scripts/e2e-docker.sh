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
