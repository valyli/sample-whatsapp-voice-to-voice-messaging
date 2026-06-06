# TTS 出站音频 API — 开发说明

> 给 `transcribe-api` 项目**新增一个 TTS（文本转语音）端点**，让 OpenClaw 调用它把回复文本变成音频，再由 OpenClaw 通过 WhatsApp channel 发成语音条给用户。
>
> 本文件是交给编程工具（Claude Code 等）的开发规格。请严格按现有项目的代码风格、CDK 结构来实现，新增内容要和现有 `/transcribe` 端点共存，**不破坏现有转写功能**。

---

## 0. 全局背景（先读这段，理解你只是「补全」而非「推翻」）

这套语音能力服务于 OpenClaw（一个 AI 助手）通过 WhatsApp 收发语音。**入站和出站各有多个可选方案，本项目是其中「自托管在用户 AWS 账号内」的那一套**，目标是稳定、可控、数据不出账号、有 SLA。其他方案（免费但非官方/本地）会并行保留，运行时随时切换。

| 方向 | 方案 A（本项目，要补全/已建） | 方案 B（保留作备选） |
|------|------------------------------|---------------------|
| 入站 语音→文本 | ✅ 已建 `POST /transcribe`（Amazon Transcribe Streaming） | 本地 `whisper.cpp`（慢，作备份） |
| 出站 文本→语音 | ⬜ **本次要新增** `POST /synthesize`（Amazon Polly） | Microsoft Edge TTS（免费、零配置、非官方接口无 SLA） |

**所以你这次的任务很聚焦：只新增出站 `POST /synthesize`（Polly TTS）端点**，和已有的 `/transcribe` 共存在同一个 CDK stack / 同一个 HTTP API 下。不要动 `/transcribe`，不要管 OpenClaw 侧如何切换（那是 OpenClaw 配置的事，不归本项目）。

---

## 1. 背景与职责边界

现有项目 `transcribe-api` 已实现**入站**：用户语音 → `POST /transcribe` → 文本。
现在要补**出站**：OpenClaw 回复文本 → `POST /synthesize` → 音频（语音条格式）。

**职责分工（重要，别越界）：**
- **本项目（AWS 侧）只负责：文本 → 音频字节**。用 Amazon Polly 合成。
- **发送到 WhatsApp 由 OpenClaw 负责**，不是本项目。所以：
  - ❌ 不要引入 Meta WhatsApp Business API
  - ❌ 不要引入 SNS / SQS / S3
  - ✅ 只做一个同步 HTTP 端点：进文本，出音频（base64）

保持和现有 `/transcribe` 一样的设计哲学：**纯同步、零常驻成本、最小权限、无中间存储**。

---

## 2. 关键技术决策（务必遵守）

### 2.1 输出格式必须是 WhatsApp 语音条兼容格式
WhatsApp 的「语音条」(voice note，带波形、可变速播放) 要求 **OGG 容器 + Opus 编码**。
- **Amazon Polly 原生支持 `OutputFormat: "ogg_vorbis"`，但那是 Vorbis 不是 Opus**，WhatsApp 不一定认。
- **正确做法**：Polly 输出 **`OutputFormat: "mp3"`**（最稳、所有语音都支持），然后**用项目已有的 ffmpeg layer 转成 `libopus` 的 ogg**：
  ```
  ffmpeg -i input.mp3 -c:a libopus -b:a 32k -ar 48000 -ac 1 output.ogg
  ```
- 这样复用了现有的 ffmpeg Lambda layer，不增加新依赖。
- **API 默认返回 ogg/opus**；同时支持通过参数返回 mp3（给非 WhatsApp 场景用）。

> ⚠️ 自带的 ffmpeg binary 是否编译了 libopus 必须先验证。如果没有，方案二：让 API 直接返回 Polly 的 mp3，由 OpenClaw 侧再转码。**实现时先验证 ffmpeg 是否支持 libopus**（`ffmpeg -encoders | grep opus`），把结论写进 README。

### 2.2 中文语音
- Polly 中文普通话推荐音色：**`Zhiyu`**（zh-CN，neural 支持）。默认用它。
- 英文默认 `Joanna`（项目原 config 里就是它）。
- 支持 neural engine（音质更好）：`Engine: "neural"`，Zhiyu / Joanna 都支持 neural。

### 2.3 长文本
- Polly 单次 `SynthesizeSpeech` 文本上限 **3000 字符**（计费字符 6000）。
- 实现时：若文本超限，**按句子/标点切分，分段合成 mp3 后用 ffmpeg concat 拼接**，再统一转 ogg。
- 先做简单版：超 3000 字符直接截断 + 返回 `truncated: true` 警告也可接受，但**最好实现分段拼接**。

---

## 3. API 规格

### 新增端点：`POST /synthesize`

**请求**（JSON）：
```json
{
  "text": "要合成的文本（必填）",
  "voiceId": "Zhiyu",          // 可选，默认 Zhiyu（中文）；英文场景传 Joanna
  "engine": "neural",          // 可选，默认 neural，可选 standard
  "format": "ogg",             // 可选，默认 ogg(opus,给WhatsApp)；可选 mp3
  "sampleRate": "48000"        // 可选，ogg 用 48000，mp3 用 24000
}
```

**鉴权**：和 `/transcribe` 一致。若 stack 设了 `apiKey`，要求请求头 `x-api-key` 匹配，否则 401。

**成功响应**（200，JSON）：
```json
{
  "ok": true,
  "audioBase64": "....",       // base64 编码的音频字节
  "format": "ogg",             // 实际返回格式
  "mimeType": "audio/ogg",     // ogg -> audio/ogg; mp3 -> audio/mpeg
  "voiceId": "Zhiyu",
  "engine": "neural",
  "characters": 42,            // 计费字符数
  "durationMs": 850
}
```

**错误响应**（4xx/5xx，JSON）：
```json
{ "ok": false, "error": "原因" }
```

返回 base64 而不是二进制流的原因：和现有 `/transcribe` 的 JSON 风格统一，OpenClaw 侧 CLI 脚本好处理。

---

## 4. 实现要求（按现有项目结构）

### 4.1 文件改动
- **新增 Lambda**：`src/synthesize-lambda/index.mjs` + `package.json`（依赖 `@aws-sdk/client-polly`）。
  - 不要和转写 Lambda 混在一个文件，各自独立、各自最小依赖。
- **改 CDK stack** `lib/transcribe-api-stack.ts`：
  - 新增一个 `SynthesizeFn` Lambda（Node 20，挂同一个 ffmpeg layer，x86_64，timeout 60s，memory 1024）。
  - IAM 只加 `polly:SynthesizeSpeech`（resources: `*`，Polly 不支持资源级限制）。
  - 在现有 `httpApi` 上加路由 `POST /synthesize` → `SynthesizeFn`。
  - 新增 `CfnOutput` 输出 synthesize 端点 URL。
- **bin/transcribe-api.ts**：如需新增可配项（默认音色等）从 context 读，保持风格。
- **README.md**：补「TTS 出站 API」章节：用法、ffmpeg libopus 验证结论、示例 curl、接入 OpenClaw 说明。

### 4.2 Lambda 实现要点（synthesize）
```
handler:
  1. 鉴权（同 transcribe）
  2. 解析 JSON body 拿 text / voiceId / engine / format / sampleRate
  3. 校验 text 非空、长度；超 3000 字符走分段
  4. 调 Polly SynthesizeSpeech (OutputFormat=mp3, Engine, VoiceId) 拿 mp3 字节
     - 分段时：多次合成 -> ffmpeg concat 拼 mp3
  5. 若 format=ogg：ffmpeg mp3 -> ogg/opus（libopus, 48k, mono, 32k bitrate）
     若 format=mp3：直接用 mp3
  6. 返回 base64 + 元数据
```
- ffmpeg 路径用现有约定 `/opt/bin/ffmpeg`，环境变量 `FFMPEG_PATH`。
- 临时文件写 `tmpdir()`，用完删（参考现有 transcribe Lambda 的 try/finally unlink 模式）。
- 错误处理、日志风格、`respond()` helper 都照搬现有 transcribe Lambda。

### 4.3 不要做的事
- 不要改动 `/transcribe` 现有逻辑。
- 不要加 S3/SNS/SQS/KMS。
- 不要引入 WhatsApp 发送逻辑。
- 不要把两个 Lambda 的依赖合并（各自 package.json）。

---

## 5. 冒烟测试

新增 `scripts/test-synthesize.sh`：
```bash
# 用法: TRANSCRIBE_API_BASE=https://xxx.execute-api.ap-northeast-1.amazonaws.com \
#        ./scripts/test-synthesize.sh "你好，这是一条测试语音" out.ogg
# 期望：拿到 out.ogg，能在播放器/手机上播放
```
脚本逻辑：POST /synthesize 拿 audioBase64 -> base64 解码写文件 -> 提示用户播放验证。

---

## 6. 部署与验证清单（交付时在 README 写明）
1. `npm install` && `cdk deploy` 后，输出里有 `SynthesizeEndpoint`。
2. 用 test-synthesize.sh 合成一段中文，确认 ogg 能播放。
3. 在手机上播放确认音质（neural Zhiyu）。
4. 把 ffmpeg 是否支持 libopus 的验证结论写进 README（这是最大不确定点）。

---

## 7. 给 OpenClaw 侧的对接说明（本项目 README 里附一段即可，OpenClaw 配置我自己来）
合成端点部署好后，OpenClaw 会这样用：
```
POST {SynthesizeEndpoint}
Content-Type: application/json
{ "text": "回复内容", "voiceId": "Zhiyu", "format": "ogg" }
-> 拿 audioBase64 -> 解码成 .ogg -> 通过 WhatsApp channel 作为语音条发送
```
所以本项目**只要保证返回的 ogg 是 WhatsApp 语音条兼容的 opus 格式**即可，发送不归本项目管。
