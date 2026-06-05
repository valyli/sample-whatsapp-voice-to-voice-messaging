# transcribe-api

同步语音转写 API，跑在 AWS 上，给 **OpenClaw 的语音消息转写**当后端。

基于 [`aws-samples/sample-whatsapp-voice-to-voice-messaging`](https://github.com/aws-samples/sample-whatsapp-voice-to-voice-messaging) 的转写核心改造而来，去掉了 Meta WhatsApp Business API / SNS / SQS / S3 那一整套（OpenClaw 用不上），重写成一个**纯同步、低延迟、按用量计费**的 HTTP 端点。

---

## 它做什么

```
POST 音频(base64) ──> API Gateway ──> Lambda ──> 返回 JSON 文本
                                         │
                                         ├─ ffmpeg: 任意格式(opus/ogg/mp3/m4a/wav) -> 16kHz mono PCM
                                         └─ Amazon Transcribe Streaming -> 转写文本
```

- **同步**：一次 POST，几秒内拿到文本。无轮询、无 S3 中转。
- **中文优先**：默认 `zh-CN`，并开启自动语言识别（中英混说也能处理）。
- **零常驻成本**：Lambda + Transcribe 全按用量计费，不用时不花钱。
- **解决了 opus 坑**：WhatsApp 语音是 opus-ogg，ffmpeg 先转码再转写。

## 为什么不用其它方案

| 方案 | 否决理由 |
|------|---------|
| Amazon Transcribe 批处理 job | 异步，要传 S3 + 轮询，延迟几十秒 |
| SageMaker / Bedrock 上跑 Whisper endpoint | 要常驻 endpoint，按小时烧钱 |
| **Transcribe Streaming（本方案）** | ✅ 同步、中文好、零常驻成本 |

---

## 架构

- **API Gateway (HTTP API)** — 接收 `POST /transcribe`
- **Lambda (Node 20)** — ffmpeg 转码 + 调 Transcribe Streaming，同步返回
- **ffmpeg Lambda Layer** — `/opt/bin/ffmpeg`（静态 binary，来自原 sample）
- **IAM** — 最小权限，只给 `transcribe:StartStreamTranscription`

> ⚠️ **架构注意**：自带的 ffmpeg binary 是 **x86-64**。默认 Lambda 也部署为 x86_64 来匹配。
> 如果你想用 arm64（更便宜约 20%），换掉 `layers/ffmpeg/bin/ffmpeg` 为 arm64 静态版，再用 `-c arch=arm64` 部署。

---

## 部署

### 前置
- AWS CLI 已配置（账号有 Transcribe / Lambda / API Gateway / IAM 权限）
- Node.js 20+
- Docker（CDK 打包 Lambda 依赖时用）
- CDK：`npm install -g aws-cdk`

### 步骤

```bash
cd transcribe-api

# 1. 装依赖
npm install

# 2. 首次用 CDK 需 bootstrap（该账号该区域只需一次）
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1

# 3. 部署（默认中文 + 自动识别 + x86_64）
cdk deploy

# 或自定义：
#   语言固定中文，不自动识别：
cdk deploy -c language=zh-CN -c identifyLanguage=false
#   加 API key 鉴权：
cdk deploy -c apiKey=your-secret-key
#   用 arm64（需先换 ffmpeg binary）：
cdk deploy -c arch=arm64
```

部署完输出里会有：

```
TranscribeApiStack.TranscribeEndpoint = https://xxxx.execute-api.ap-northeast-1.amazonaws.com/transcribe
```

记下这个 URL。

### 冒烟测试

```bash
TRANSCRIBE_API_URL=https://xxxx.execute-api.ap-northeast-1.amazonaws.com/transcribe \
  ./scripts/test-local.sh /path/to/voice.ogg
```

期望返回：
```json
{ "ok": true, "transcript": "你说的内容", "language": "zh-CN", "durationMs": 2100 }
```

---

## 接入 OpenClaw

部署好后，把 OpenClaw 的语音转写后端从「本地 whisper」切到这个云端 API：

1. 编辑 `transcribe-api/openclaw/transcribe-remote.sh`，把 `TRANSCRIBE_API_URL` 改成你的端点（或通过环境变量传入）。

2. 把脚本放到 OpenClaw 能访问的路径，例如：
   ```bash
   cp openclaw/transcribe-remote.sh ~/.openclaw/workspace/transcribe-remote.sh
   chmod +x ~/.openclaw/workspace/transcribe-remote.sh
   ```

3. 在 OpenClaw 配置 `~/.openclaw/openclaw.json` 里，把 `tools.media.audio.models` 的 CLI command 指向它：
   ```json
   {
     "tools": {
       "media": {
         "audio": {
           "enabled": true,
           "echoTranscript": true,
           "echoFormat": "🎙️ \"{transcript}\"",
           "models": [
             {
               "type": "cli",
               "command": "/home/ubuntu/.openclaw/workspace/transcribe-remote.sh",
               "args": ["{{MediaPath}}"],
               "timeoutSeconds": 60
             }
           ]
         }
       }
     }
   }
   ```

4. 重启 OpenClaw gateway，发条语音测试。

---

## API 参考

### `POST /transcribe`

**方式 1 — JSON（推荐）**
```json
{
  "audioBase64": "<base64 音频>",
  "language": "zh-CN",        // 可选，覆盖默认
  "identifyLanguage": true     // 可选，自动识别语言
}
```

**方式 2 — 原始二进制**
直接把音频字节作为 body POST，`content-type` 非 json 即可。

**响应**
```json
{ "ok": true, "transcript": "...", "language": "zh-CN", "durationMs": 1234 }
```
失败：
```json
{ "ok": false, "error": "..." }
```

**鉴权**（若部署时设了 `apiKey`）：请求头加 `x-api-key: <你的key>`

---

## 配置项（部署时 `-c` 传）

| context key | 默认 | 说明 |
|-------------|------|------|
| `language` | `zh-CN` | Transcribe 语言码 |
| `identifyLanguage` | `true` | 自动识别语言（中英混说） |
| `languageOptions` | `zh-CN,en-US` | 自动识别候选 |
| `arch` | `x86_64` | Lambda 架构（arm64 需换 ffmpeg） |
| `apiKey` | 空 | 设了则要求 `x-api-key` 头 |

---

## 成本估算（参考）

- **Transcribe Streaming**：约 $0.024 / 分钟（前 250k 分钟档）
- **Lambda**：1024MB，每次几秒，几乎可忽略
- **API Gateway HTTP API**：$1 / 百万请求
- 一条 15 秒语音 ≈ **$0.006**（不到 5 分钱人民币），不用时 **$0**

---

## 清理

```bash
cdk destroy
```

---

## License

转写核心借鉴自 aws-samples（MIT-0）。本目录代码同 MIT。
