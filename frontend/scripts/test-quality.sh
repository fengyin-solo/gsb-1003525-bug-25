#!/usr/bin/env bash
# 水质领域不变量测试：用纯 JS 的 tsc 编到临时目录后由 node:test 执行，
# 不依赖 esbuild 原生二进制（仓库 node_modules 可能是在别的平台装的）。
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

SRCS=(
  src/data/quality/types.ts
  src/data/quality/seed.ts
  src/data/quality/engine.ts
  src/data/quality/store.ts
  src/data/quality/__tests__/helpers.ts
  src/data/quality/__tests__/quality.test.ts
)

./node_modules/.bin/tsc "${SRCS[@]}" \
  --outDir "$OUT" \
  --module commonjs \
  --moduleResolution node \
  --target es2020 \
  --strict \
  --skipLibCheck \
  --esModuleInterop

node --test "$OUT/__tests__/quality.test.js"
