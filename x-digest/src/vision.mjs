/**
 * 看图：把图片 URL 交给云端视觉模型，换回一句文字描述。
 *
 * 为什么需要它：DeepSeek 官方 API 是纯文本的（实测图片会被标成 [Unsupported Image]），
 * 所以"图片里是什么"这类问题必须借一个视觉模型。
 *
 * 接口用 OpenAI 兼容格式，换供应商只改三行配置：
 *   阿里百炼  https://dashscope.aliyuncs.com/compatible-mode/v1   qwen-vl-max
 *   智谱      https://open.bigmodel.cn/api/paas/v4                glm-4v-plus
 *   硅基流动  https://api.siliconflow.cn/v1                       Qwen/Qwen2.5-VL-72B-Instruct
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

export class VisionError extends Error {}

export function visionReady(cfg) {
  return Boolean(cfg?.vision?.apiKey && cfg?.vision?.baseUrl && cfg?.vision?.model);
}

/**
 * 部分模型（DeepSeek 系）默认会先"思考"，把 max_tokens 全花在 reasoning 上，
 * 导致 content 为空。看图这种任务不需要思考，直接关掉。
 */
function extraBodyFor(model) {
  return /deepseek/i.test(String(model)) ? { enable_thinking: false } : {};
}

/**
 * 把图片下载下来转成 data URL。
 *
 * 为什么不用原始 URL：不少国内站点（含百炼香港工作空间）**自己下载不了境外图片**，
 * 会报 "Failed to download multimodal content"。我们本地下载（有代理）再内联，最稳。
 */
async function toDataUrl(imageUrl, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (imageUrl.startsWith('data:')) return imageUrl;

  let res;
  try {
    res = await fetch(imageUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; x-digest/0.1)' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new VisionError(`下载图片失败：${err.message}`);
  }
  if (!res.ok) throw new VisionError(`下载图片失败：HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new VisionError('下载到的图片是空的');
  if (buf.length > maxBytes) throw new VisionError(`图片太大（${Math.round(buf.length / 1024 / 1024)}MB）`);

  const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return `data:${type};base64,${buf.toString('base64')}`;
}

/**
 * @param {string} imageUrl 图片地址（https 或 data:）
 * @param {object} cfg
 * @param {{prompt?: string}} opts
 * @returns {Promise<string>} 一句中文描述；失败时抛 VisionError
 */
export async function describeImage(imageUrl, cfg, { prompt } = {}) {
  if (!visionReady(cfg)) throw new VisionError('没有配置视觉模型（VISION_API_KEY / VISION_BASE_URL / VISION_MODEL）');
  if (!imageUrl) throw new VisionError('没有图片地址');

  const dataUrl = await toDataUrl(imageUrl);

  const body = {
    model: cfg.vision.model,
    max_tokens: 800,
    ...extraBodyFor(cfg.vision.model),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              prompt ??
              '用一两句中文说清楚这张图的内容，重点说"它是什么/在讲什么"，不要客套，不要"这张图片展示了"。',
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  let res;
  try {
    res = await fetch(`${cfg.vision.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.vision.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    throw new VisionError(`连不上视觉模型：${err.message}`);
  }

  const raw = await res.text();
  if (!res.ok) throw new VisionError(`视觉模型 HTTP ${res.status}: ${raw.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VisionError(`视觉模型返回非 JSON：${raw.slice(0, 200)}`);
  }

  const text = String(parsed?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new VisionError('视觉模型返回了空内容');
  return text.slice(0, 400);
}

/** 读视频时长（秒）：从 ffmpeg 的 stderr 里解析 Duration。 */
async function probeDuration(file) {
  try {
    await run(ffmpegPath, ['-i', file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const text = String(err?.stderr ?? '');
    const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

/** 按时长均匀选采样点：短片的抽 3 帧，长片最多 8 帧，覆盖整段。 */
function sampleTimes(duration, maxFrames = 8) {
  if (!duration || duration < 2) return [1];
  const n = Math.min(maxFrames, Math.max(3, Math.round(duration / 8)));
  const times = [];
  for (let i = 0; i < n; i += 1) {
    // 从 5% 到 95% 均匀分布，避免片头片尾黑帧
    const t = duration * (0.05 + (0.9 * i) / Math.max(1, n - 1));
    times.push(Math.max(0.2, Number(t.toFixed(1))));
  }
  return times;
}

/**
 * 视频理解：下载 mp4 → 按**整段时长**均匀抽帧 → 多图交给视觉模型。
 *
 * DeepSeek 不支持视频输入（video_url 和视频文件都不收），所以抽帧是唯一路子。
 * 关键是均匀覆盖全片，而不是只看开头几秒。
 */
export async function describeVideo(videoUrl, cfg, { maxFrames = 8, maxBytes = 80 * 1024 * 1024 } = {}) {
  if (!visionReady(cfg)) throw new VisionError('没有配置视觉模型');
  if (!videoUrl) throw new VisionError('没有视频地址');
  if (!ffmpegPath) throw new VisionError('ffmpeg 不可用');

  // 1. 下载
  let res;
  try {
    res = await fetch(videoUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; x-digest/0.1)' },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new VisionError(`下载视频失败：${err.message}`);
  }
  if (!res.ok) throw new VisionError(`下载视频失败：HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new VisionError('下载到的视频是空的');
  if (buf.length > maxBytes) throw new VisionError(`视频太大（${Math.round(buf.length / 1024 / 1024)}MB）`);

  // 临时目录放在 data/ 下面，不要用系统 %TEMP%：
  // 本机的沙箱会让子进程（ffmpeg）写 %TEMP% 失败，表现为 "Conversion failed!"
  const base = cfg?.dataDir ?? process.cwd();
  const dir = path.join(base, 'video-tmp', String(Date.now()));
  mkdirSync(dir, { recursive: true });
  const videoFile = path.join(dir, 'v.mp4');
  writeFileSync(videoFile, buf);

  // 2. 先读时长，再按整段均匀抽帧（不只是开头几秒）
  const duration = await probeDuration(videoFile);
  const times = sampleTimes(duration, maxFrames);

  const images = [];
  const usedTimes = [];
  let lastErr = '';
  try {
    for (const t of times) {
      const out = path.join(dir, `f-${t}.jpg`);
      try {
        await run(
          ffmpegPath,
          ['-ss', String(t), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', '-update', '1', '-y', out],
          { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (err) {
        // ffmpeg 有时写完了帧却以非 0 退出（Conversion failed），所以不直接放弃，
        // 下面按"文件到底有没有生成"来判断
        lastErr = String(err?.stderr || err?.message || '').slice(-200);
      }
      if (existsSync(out) && statSync(out).size > 2000) {
        images.push(`data:image/jpeg;base64,${readFileSync(out).toString('base64')}`);
        usedTimes.push(t);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!images.length) throw new VisionError(`没能从视频里抽到帧：${lastErr || '未知原因'}`);

  // 3. 多帧一起问
  const body = {
    model: cfg.vision.model,
    max_tokens: 1000,
    ...extraBodyFor(cfg.vision.model),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `这个视频总长 ${duration ? Math.round(duration) + ' 秒' : '未知'}，下面按时间顺序给出了 ${images.length} 帧` +
              `（对应时间点：${usedTimes.map((t) => t + 's').join('、')}），覆盖了整段视频。\n` +
              '请用两三句中文说清楚：整个视频在讲什么、内容有没有变化、有没有值得看的信息（数据/演示/画面）。不要客套。',
          },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
  };

  let vr;
  try {
    vr = await fetch(`${cfg.vision.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.vision.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new VisionError(`视频识别请求失败：${err.message}`);
  }

  const raw = await vr.text();
  if (!vr.ok) throw new VisionError(`视频识别 HTTP ${vr.status}: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(raw);
  const text = String(parsed?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new VisionError('视频识别返回了空内容');
  return text.slice(0, 500);
}


