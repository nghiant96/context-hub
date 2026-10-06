#!/bin/bash
# Cài context-hub cho Claude Code trên Mac: kiểm tra Node.js, giải nén file
# context-hub-*.mcpb (để cạnh script này hoặc trong Downloads) vào
# ~/context-hub-mcp, rồi chạy trình cài để gắn vào Claude Code.
# Chạy: bash ~/Downloads/cai-dat-context-hub.sh
set -euo pipefail

DEST="$HOME/context-hub-mcp"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Chưa có Node.js. Tải bản LTS tại https://nodejs.org, cài xong mở cửa sổ Terminal mới rồi chạy lại script này."
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js $(node --version) đã cũ, cần bản 22.13 trở lên. Tải bản LTS tại https://nodejs.org rồi chạy lại."
  exit 1
fi

MCPB="$(ls -t "$HERE"/context-hub-*.mcpb "$HOME"/Downloads/context-hub-*.mcpb 2>/dev/null | head -1 || true)"
if [ -z "$MCPB" ]; then
  echo "Không thấy file context-hub-*.mcpb. Tải ở https://github.com/nghiant96/context-hub/releases/latest, để cạnh script này hoặc trong Downloads."
  exit 1
fi
echo "Dùng $MCPB"
mkdir -p "$DEST"
tar -xf "$MCPB" -C "$DEST"

node "$DEST/server/index.mjs" --install
