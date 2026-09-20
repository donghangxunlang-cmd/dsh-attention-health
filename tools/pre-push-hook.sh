#!/bin/sh
# pre-push 闸门（模板）—— 2026-09-20 AE 节
#
# 装法（**本文件进库，但 .git/hooks/pre-push 不进库**，避免把本机路径写死进公开仓库）：
#   cp tools/pre-push-hook.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
#
# 行为：推送前扫一遍仓库内容，身份类命中 > 0 就**拒绝推送**。
# node 解析顺序：$DSH_NODE_EXE → PATH 上的 node（因此文件里不含任何本机绝对路径）。

ROOT="$(git rev-parse --show-toplevel)"
NODE_BIN="${DSH_NODE_EXE:-$(command -v node)}"

if [ -z "$NODE_BIN" ]; then
  echo "pre-push: 找不到 node（可设 DSH_NODE_EXE）—— 为安全起见拒绝推送" >&2
  exit 1
fi

"$NODE_BIN" "$ROOT/tools/scan-identity.mjs" "$ROOT" || {
  echo "" >&2
  echo "pre-push: **已拦下** —— 待推送内容里有身份类信息。" >&2
  echo "  公开产物请用： node tools/make-release.mjs" >&2
  exit 1
}
