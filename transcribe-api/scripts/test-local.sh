#!/usr/bin/env bash
# transcribe-api/scripts/test-local.sh
#
# 部署后冒烟测试。用一段真实音频打 API，看返回。
# 用法: TRANSCRIBE_API_URL=https://xxx/transcribe ./scripts/test-local.sh path/to/audio.ogg
set -euo pipefail

API_URL="${TRANSCRIBE_API_URL:?set TRANSCRIBE_API_URL to the cdk output endpoint}"
API_KEY="${TRANSCRIBE_API_KEY:-}"
AUDIO="${1:?usage: test-local.sh <audio-file>}"

echo ">> POST $AUDIO -> $API_URL"
B64="$(base64 -w0 "$AUDIO" 2>/dev/null || base64 "$AUDIO" | tr -d '\n')"

HDR_KEY=()
[ -n "$API_KEY" ] && HDR_KEY=(-H "x-api-key: $API_KEY")

curl -sS --max-time 60 -X POST "$API_URL" \
  -H 'content-type: application/json' \
  "${HDR_KEY[@]}" \
  -d "{\"audioBase64\":\"$B64\"}" | (command -v jq >/dev/null && jq . || cat)
echo
