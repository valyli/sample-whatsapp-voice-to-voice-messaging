#!/usr/bin/env bash
# transcribe-api/openclaw/transcribe-remote.sh
#
# OpenClaw 语音转写 wrapper —— 调用部署好的 AWS Transcribe API。
# 用法: transcribe-remote.sh <音频文件路径>
# 输出: 纯文本转写结果到 stdout（OpenClaw 的 tools.media.audio CLI 模式要求）
#
# 部署 transcribe-api 后，把 OpenClaw 配置里的 command 指向本脚本。
# 需要设置环境变量（或直接改下面默认值）：
#   TRANSCRIBE_API_URL   —— cdk deploy 输出的 TranscribeEndpoint
#   TRANSCRIBE_API_KEY   —— 若部署时设了 apiKey（可选）
set -euo pipefail

API_URL="${TRANSCRIBE_API_URL:-https://REPLACE_ME.execute-api.ap-northeast-1.amazonaws.com/transcribe}"
API_KEY="${TRANSCRIBE_API_KEY:-}"
AUDIO="${1:?need audio path}"

if [ ! -f "$AUDIO" ]; then
  echo "audio not found: $AUDIO" >&2
  exit 1
fi

# 把音频 base64 后用 JSON 发出去
B64="$(base64 -w0 "$AUDIO" 2>/dev/null || base64 "$AUDIO" | tr -d '\n')"

HDR_KEY=()
[ -n "$API_KEY" ] && HDR_KEY=(-H "x-api-key: $API_KEY")

RESP="$(curl -sS --max-time 60 -X POST "$API_URL" \
  -H 'content-type: application/json' \
  "${HDR_KEY[@]}" \
  -d "{\"audioBase64\":\"$B64\"}")"

# 提取 transcript 字段（优先 jq，无 jq 退回 grep）
if command -v jq >/dev/null 2>&1; then
  OK="$(printf '%s' "$RESP" | jq -r '.ok // false')"
  if [ "$OK" != "true" ]; then
    echo "transcribe failed: $(printf '%s' "$RESP" | jq -r '.error // "unknown"')" >&2
    exit 1
  fi
  printf '%s\n' "$RESP" | jq -r '.transcript // ""'
else
  printf '%s' "$RESP" | grep -o '"transcript"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed 's/.*:[[:space:]]*"//; s/"$//'
fi
