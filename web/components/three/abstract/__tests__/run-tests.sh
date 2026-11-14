#!/bin/sh
# Run the abstract-view unit tests.
#
# The repo has no test framework installed and we must not add one, so the
# tests use node's built-in runner (`node:test`). They cover the pure modules
# only — layout, triangulation, scaling — which is deliberate: the React/three
# components are verified by rendering them (see __scratch__/Harness.tsx).
#
# Usage: sh components/three/abstract/__tests__/run-tests.sh   (from web/)
set -e
WEB="$(cd "$(dirname "$0")/../../../.." && pwd)"
OUT="${TMPDIR:-/tmp}/athanor-abstract-tests"
rm -rf "$OUT"
cd "$WEB"
npx tsc \
  components/three/abstract/__tests__/treeLayout.test.ts \
  components/three/abstract/__tests__/geometry.test.ts \
  --outDir "$OUT" \
  --module commonjs --target es2022 --moduleResolution node \
  --strict --skipLibCheck --esModuleInterop --resolveJsonModule
node --test "$OUT/__tests__/"
