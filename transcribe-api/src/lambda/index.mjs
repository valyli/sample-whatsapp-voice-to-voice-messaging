// transcribe-api/src/lambda/index.mjs
//
// 同步语音转写 Lambda（给 OpenClaw 当转写后端用）
// 输入：HTTP POST，body 是 base64 编码的音频（任意格式：opus/ogg/mp3/m4a/wav...）
// 处理：ffmpeg 转成 16kHz mono PCM -> Amazon Transcribe Streaming
// 输出：JSON { ok, transcript, language, durationMs }
//
// 设计要点：
// - 无 S3 / 无 SNS / 无 SQS，纯同步，最低延迟
// - 用 Transcribe Streaming（不是异步 job，不轮询）
// - ffmpeg 来自 Lambda layer (/opt/bin/ffmpeg)
//
// 借鉴自 aws-samples/sample-whatsapp-voice-to-voice-messaging 的 TranscribeService，
// 重写为同步 + 多语言（默认中文）+ 直接收 body（不经 S3）。

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from '@aws-sdk/client-transcribe-streaming';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
// 默认语言。Transcribe 语言码：zh-CN 普通话, en-US 英文。
// 也支持 identify-language 自动识别（见下）。
const DEFAULT_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || 'zh-CN';
// 是否自动识别语言（中英混说场景）。开启时忽略 DEFAULT_LANGUAGE 的单一约束。
const IDENTIFY_LANGUAGE = (process.env.TRANSCRIBE_IDENTIFY_LANGUAGE || 'true').toLowerCase() === 'true';
// 自动识别时的候选语言（逗号分隔）。
const LANGUAGE_OPTIONS = (process.env.TRANSCRIBE_LANGUAGE_OPTIONS || 'zh-CN,en-US').split(',').map(s => s.trim());
const FFMPEG = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg';
const SAMPLE_RATE = 16000;

const transcribeClient = new TranscribeStreamingClient({ region: REGION });

/**
 * 用 ffmpeg 把任意音频转成 16kHz mono 16-bit PCM (s16le)
 * 返回 PCM buffer
 */
function toPcm(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `${randomUUID()}.pcm`);
    const ff = spawn(FFMPEG, [
      '-nostdin',
      '-i', inputPath,
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      outPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) {
        try {
          const buf = readFileSync(outPath);
          unlinkSync(outPath);
          resolve(buf);
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

/**
 * 把 PCM buffer 切块喂给 Transcribe Streaming，收集最终 transcript
 */
async function transcribePcm(pcmBuffer, opts = {}) {
  const language = opts.language || DEFAULT_LANGUAGE;
  const identify = opts.identifyLanguage ?? IDENTIFY_LANGUAGE;

  async function* audioStream() {
    const chunkSize = 1024 * 8; // 8KB 块
    for (let i = 0; i < pcmBuffer.length; i += chunkSize) {
      yield { AudioEvent: { AudioChunk: pcmBuffer.subarray(i, i + chunkSize) } };
    }
  }

  const params = {
    MediaSampleRateHertz: SAMPLE_RATE,
    MediaEncoding: 'pcm',
    AudioStream: audioStream(),
  };

  if (identify) {
    params.IdentifyLanguage = true;
    params.LanguageOptions = LANGUAGE_OPTIONS.join(',');
    params.PreferredLanguage = language;
  } else {
    params.LanguageCode = language;
  }

  const command = new StartStreamTranscriptionCommand(params);
  const response = await transcribeClient.send(command);

  let transcript = '';
  let detectedLanguage = identify ? undefined : language;

  for await (const event of response.TranscriptResultStream || []) {
    if (event.TranscriptEvent) {
      const results = event.TranscriptEvent.Transcript?.Results || [];
      for (const result of results) {
        if (!result.IsPartial) {
          transcript += (result.Alternatives?.[0]?.Transcript || '') + ' ';
          if (result.LanguageCode) detectedLanguage = result.LanguageCode;
        }
      }
    }
  }

  return { transcript: transcript.trim(), language: detectedLanguage };
}

/**
 * 解析进来的请求 body -> 音频 buffer
 * 支持两种：
 *   1. JSON: { "audioBase64": "...", "language": "zh-CN", "identifyLanguage": true }
 *   2. 直接二进制（base64 编码，isBase64Encoded=true）
 */
function parseBody(event) {
  const isB64 = event.isBase64Encoded;
  const raw = event.body || '';
  const contentType = (event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const json = JSON.parse(isB64 ? Buffer.from(raw, 'base64').toString('utf8') : raw);
    if (!json.audioBase64) throw new Error('missing audioBase64 in JSON body');
    return {
      audio: Buffer.from(json.audioBase64, 'base64'),
      language: json.language,
      identifyLanguage: json.identifyLanguage,
    };
  }
  // 否则当成原始音频二进制
  return { audio: isB64 ? Buffer.from(raw, 'base64') : Buffer.from(raw) };
}

export const handler = async (event) => {
  const started = Date.now();
  const respond = (statusCode, obj) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });

  try {
    // 可选 API key 鉴权
    const requiredKey = process.env.API_KEY;
    if (requiredKey) {
      const got = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
      if (got !== requiredKey) return respond(401, { ok: false, error: 'unauthorized' });
    }

    const { audio, language, identifyLanguage } = parseBody(event);
    if (!audio || audio.length < 100) {
      return respond(400, { ok: false, error: 'audio too small or missing' });
    }

    // 写临时文件给 ffmpeg
    const inPath = join(tmpdir(), `${randomUUID()}.input`);
    writeFileSync(inPath, audio);

    let pcm;
    try {
      pcm = await toPcm(inPath);
    } finally {
      try { unlinkSync(inPath); } catch {}
    }

    const { transcript, language: detected } = await transcribePcm(pcm, { language, identifyLanguage });

    return respond(200, {
      ok: true,
      transcript,
      language: detected,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    console.error('transcribe error:', err);
    return respond(500, { ok: false, error: String(err?.message || err) });
  }
};
