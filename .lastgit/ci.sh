#!/usr/bin/env bash
# Required LastGit status gate for the org app.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

# 1. shell syntax
for f in .lastgit/*.sh; do
  [ -f "$f" ] || continue
  echo "bash -n $f"
  bash -n "$f"
done

# 2. install deps (cached when possible)
if [ -f package.json ]; then
  echo "bun install"
  bun install --frozen-lockfile 2>/dev/null || bun install
fi

# 3. typecheck
if [ -f tsconfig.json ]; then
  echo "bun run typecheck"
  bun run typecheck
fi

# 4. unit tests
if [ -d test ]; then
  echo "bun test"
  bun test
fi

# 5. venue pin
test "$(head -n 1 .last-stack/pr-venue)" = "lastgit"

echo "ci-required: ok"
