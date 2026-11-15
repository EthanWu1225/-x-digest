/**
 * 监听 @ 我的提及，并自动回复。
 *
 * 数据来源：x.com 的 v2 notifications 接口（cookie 会话，免费）
 *   GET /i/api/2/notifications/mentions.json
 *
 * 安全边界（重要）：
 *   · 只回复 MENTION_WHITELIST 里的账号（默认就是你的主号），其他人一律不理
 *   · 每轮最多回 1 条，每小时最多 3 条，避免变成 spam bot
 *   · 只处理 24 小时内的提及，重启不会去回很久以前的
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadSessionFromFile } from './xsession.mjs';
import { withContext, replyToTweet } from './browser.mjs';
import { describeImage, describeVideo, visionReady } from './vision.mjs';
import { recordHistory } from './history.mjs';

const DEFAULT_PROMPT = `你在替一个技术型博主打理 X（推特）。有人 @ 了他，写一句回复。

要求：
- 中文，一句话，不超过 50 字
- 自然、具体，接住对方说的内容，不要客套话（不要"很高兴""感谢分享"这类）
- 不承诺做不到的事，不确定就说不确定
- 只输出回复正文，不要引号、不要解释`;

/** 提示词文件：prompts/mention-reply.md，每次调用现读，改完即时生效。 */
export function promptFile(cfg) {
  return path.join(cfg.root ?? process.cwd(), 'prompts', 'mention-reply.md');
}

export function readReplyPrompt(cfg) {
  try {
    const text = readFileSync(promptFile(cfg), 'utf8').trim();
    return text || DEFAULT_PROMPT;
  } catch {
    return DEFAULT_PROMPT;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function mentionsStateFile(cfg) {
  return path.join(cfg.dataDir, 'mentions.json');
}

/** 从通知响应里挖出「@ 我」的推文（结构可能变，所以多套一层兜底）。 */
export function extractMentions(body, selfHandle) {
  const out = [];
  const globalTweets = body?.globalObjects?.tweets ?? {};
  const globalUsers = body?.globalObjects?.users ?? {};

  const resolveUser = (tweet) =>
    String(
      tweet?.user?.screen_name ??
        tweet?.core?.user_results?.result?.legacy?.screen_name ??
        globalUsers?.[tweet?.user_id_str ?? tweet?.user_id]?.screen_name ??
        '',
    ).replace(/^@/, '');

  // 入口一：老式 globalObjects + timeline 引用
  const entries = (body?.timeline?.instructions ?? []).flatMap((i) => i?.addEntries?.entries ?? []);
  const seen = new Set();

  for (const entry of entries) {
    // 新结构：content.item.content.tweet 只是一个 { id }
    const ref = entry?.content?.item?.content?.tweet;
    if (ref?.id) {
      const tweet = globalTweets[ref.id] ?? null;
      if (tweet) {
        seen.add(String(ref.id));
        out.push(toItem(tweet, resolveUser(tweet)));
      }
      continue;
    }

    // 旧结构：content.tweet 就是完整推文
    const direct = entry?.content?.tweet ?? entry?.content?.notification?.tweet ?? null;
    if (direct) {
      const id = String(direct.id_str ?? direct.id ?? direct.rest_id ?? '');
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(toItem(direct, resolveUser(direct)));
      }
    }
  }

  // 入口二：globalObjects 里有、但 timeline 没引用的（保险起见一并看）
  for (const [id, tweet] of Object.entries(globalTweets)) {
    if (seen.has(String(id))) continue;
    out.push(toItem(tweet, resolveUser(tweet)));
  }

  function toItem(tweet, handle) {
    const id = String(tweet.id_str ?? tweet.id ?? tweet.rest_id ?? '');
    return {
      id,
      handle: handle || '',
      text: String(tweet.full_text ?? tweet.text ?? ''),
      createdAt: Number(tweet.created_at) || Date.parse(tweet.created_at ?? '') || 0,
      // 这条 @ 是在回复谁 —— 拿它能补上"这/它"指向的上下文
      inReplyTo: String(tweet.in_reply_to_status_id_str ?? ''),
      url: `https://x.com/${handle || 'i'}/status/${id}`,
    };
  }

  return out.filter(
    (m) => m.id && m.handle && m.text && (!selfHandle || m.handle.toLowerCase() !== String(selfHandle).toLowerCase()),
  );
}

export async function fetchMentions(cfg, session) {
  const s = session ?? loadSessionFromFile(cfg);
  const bot = String(cfg.botHandle ?? '').replace(/^@/, '').toLowerCase();

  // 用 all 通知流（mentions 标签页的索引会滞后十几分钟）
  const body = await s.notifications({ count: 50 });
  const all = extractMentions(body, bot);

  // 自己筛：正文里必须真的 @ 了机器人
  const mentioned = bot ? all.filter((m) => m.text.toLowerCase().includes(`@${bot}`)) : all;
  return mentioned;
}

/** 让 DeepSeek 写一句回复。 */
export async function draftReply(cfg, mention, { parentText = '' } = {}) {
  const res = await fetch(`${cfg.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.deepseek.apiKey}` },
    body: JSON.stringify({
      model: cfg.deepseek.model,
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { role: 'system', content: readReplyPrompt(cfg) },
        {
          role: 'user',
          content: [
            parentText
              ? `他回复的那条推文（也就是"这/它"指的是）：\n${parentText.slice(0, 500)}\n`
              : '（他没有引用别的推文，就是单独 @ 你）\n',
            `他说：${mention.text.slice(0, 500)}`,
            '',
            '写一句回复。注意：',
            '- 如果上面有原推内容，就接着原推的主题回，别问"你要我看什么"',
            '- 如果确实什么信息都没有（只有一句空泛的 @），就只输出 SKIP 四个字母，表示这轮不回',
            '- 只输出回复正文或 SKIP，不要解释',
          ].join('\n'),
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${raw.slice(0, 200)}`);
  const text = JSON.parse(raw)?.choices?.[0]?.message?.content ?? '';
  const cleaned = text.trim().replace(/^["'「]|["'」]$/g, '');
  if (/^SKIP$/i.test(cleaned)) return '';
  return cleaned.slice(0, 200);
}

/**
 * 跑一轮：找新的 @ → 生成回复 → 用浏览器发出去。
 * @returns {{ matched: number, replied: number, skipped: number, details: string[] }}
 */
let running = false;

export async function processMentions(cfg, logger = console) {
  // 一轮可能要 3–5 分钟（每条都要开浏览器），定时器 5 分钟一次会撞上，加个锁
  if (running) {
    return { matched: 0, replied: 0, skipped: 0, details: ['上一轮 @ 检查还没跑完'] };
  }
  running = true;
  try {
    return await runMentionCycle(cfg, logger);
  } finally {
    running = false;
  }
}

async function runMentionCycle(cfg, logger) {
  const state = readJson(mentionsStateFile(cfg), { handled: {}, lastCheck: 0 });
  const result = { matched: 0, replied: 0, skipped: 0, details: [] };

  if (!cfg.mentionWatch) {
    result.details.push('监听未开启');
    return result;
  }

  let mentions;
  try {
    mentions = await fetchMentions(cfg);
  } catch (err) {
    result.details.push(`读通知失败：${err.message}`);
    return result;
  }

  const whitelist = new Set(cfg.mentionWhitelist.map((h) => h.toLowerCase()));
  const maxAge = 24 * 3600_000;

  const pending = mentions.filter((m) => !state.handled[m.id] && Date.now() - m.createdAt < maxAge);
  // 老的先回：否则新 @ 源源不断时，早先那条会被一直挤到队尾
  const fresh = pending.filter((m) => whitelist.has(m.handle.toLowerCase())).sort((a, b) => a.createdAt - b.createdAt);

  result.matched = fresh.length;

  // 诊断：有 @ 但不在白名单里，说清楚，别让它静默消失
  const ignored = pending.filter((m) => !whitelist.has(m.handle.toLowerCase()));
  if (ignored.length) {
    const who = [...new Set(ignored.map((m) => `@${m.handle}`))].slice(0, 5).join(' ');
    result.details.push(`忽略 ${ignored.length} 条（不在白名单）：${who}`);
  }

  if (!fresh.length) {
    state.lastCheck = Date.now();
    writeJson(mentionsStateFile(cfg), state);
    return result;
  }

  // 一轮处理几条（默认 3）：只回一条时，连发两条 @ 的其中一条要等下一轮
  const limit = Math.max(1, Number(cfg.mentionMaxPerCycle) || 3);
  const targets = fresh.slice(0, limit);
  if (fresh.length > limit) {
    result.details.push(`还有 ${fresh.length - limit} 条下轮再回`);
  }

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];

    if (i > 0 && cfg.commentGapSeconds > 0) {
      logger.info?.(`等下一条 @（${cfg.commentGapSeconds} 秒）…`);
      await new Promise((r) => setTimeout(r, cfg.commentGapSeconds * 1000));
    }

    // 这条 @ 如果是在回复别人的推，先把原推内容取出来
    // （否则模型只看到"这是什么"，只能回"我看不到"）
    let parentText = '';
    let parentImages = [];
    let parentVideo = '';
    if (target.inReplyTo) {
      try {
        const session = loadSessionFromFile(cfg);
        const conv = await session.conversation(target.inReplyTo);
        parentText = conv.root?.text ?? '';
        parentImages = conv.root?.images ?? [];
        parentVideo = conv.root?.videoUrl ?? '';
        if (parentText) logger.info?.(`取到原推上下文：${parentText.slice(0, 60)}…`);
      } catch (err) {
        logger.warn?.(`取原推失败（将按无上下文处理）：${err.message}`);
      }
    }

    if (parentImages.length && visionReady(cfg)) {
      try {
        const desc = await describeImage(parentImages[0], cfg);
        parentText += `\n[配图内容] ${desc}`;
        logger.info?.(`看图：${desc.slice(0, 60)}…`);
      } catch (err) {
        logger.warn?.(`看图失败（不影响回复）：${err.message}`);
      }
    } else if (parentVideo && visionReady(cfg) && cfg.visionVideo) {
      try {
        const desc = await describeVideo(parentVideo, cfg, { maxFrames: cfg.visionVideoFrames });
        parentText += `\n[视频内容] ${desc}`;
        logger.info?.(`看视频：${desc.slice(0, 50)}…`);
      } catch (err) {
        logger.warn?.(`视频识别失败（不影响回复）：${err.message}`);
      }
    }

    let text;
    try {
      text = await draftReply(cfg, target, { parentText });
    } catch (err) {
      result.details.push(`生成回复失败（@${target.handle}）：${err.message}`);
      continue;
    }

    if (!text) {
      state.handled[target.id] = { at: Date.now(), handle: target.handle, text: '', skipped: true };
      result.skipped += 1;
      result.details.push(`跳过 @${target.handle}：信息不足`);
      recordHistory(cfg, { id: target.id, handle: target.handle, text: target.text, url: target.url, reason: '模型判断信息不足', action: 'mention-skipped' });
      continue;
    }

    logger.info?.(`回复 @${target.handle}：${text}`);

    try {
      await withContext(cfg, async (context) => {
        await Promise.race([
          replyToTweet(context, target.url, text, { fast: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器发送超时（120 秒）')), 120_000)),
        ]);
      });
      state.handled[target.id] = { at: Date.now(), handle: target.handle, text };
      result.replied += 1;
      result.details.push(`已回复 @${target.handle}`);
      recordHistory(cfg, { id: target.id, handle: target.handle, text: target.text, url: target.url, reason: text.slice(0, 120), action: 'mention-posted' });
    } catch (err) {
      // 发失败不标记 handled，下一轮重试；但最多试 3 次，避免一条坏数据永远占坑
      state.attempts = state.attempts ?? {};
      state.attempts[target.id] = (state.attempts[target.id] ?? 0) + 1;
      result.details.push(`发送失败 @${target.handle}（第 ${state.attempts[target.id]} 次）：${err.message}`);
      recordHistory(cfg, { id: target.id, handle: target.handle, text: target.text, url: target.url, reason: err.message.slice(0, 120), action: 'mention-failed' });
      if (state.attempts[target.id] >= 3) {
        state.handled[target.id] = { at: Date.now(), handle: target.handle, text: '', failed: true };
        result.details.push(`放弃 @${target.handle}（连续 3 次失败）`);
      }
    }
  }

  state.lastCheck = Date.now();
  writeJson(mentionsStateFile(cfg), state);
  return result;
}
export { mentionsStateFile };







