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
import { launchContext, replyToTweet, closeContext } from './browser.mjs';

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
  const body = await s.notifications({ count: 20 });
  const all = extractMentions(body, bot);

  // 自己筛：正文里必须真的 @ 了机器人
  const mentioned = bot ? all.filter((m) => m.text.toLowerCase().includes(`@${bot}`)) : all;
  return mentioned;
}

/** 让 DeepSeek 写一句回复。 */
export async function draftReply(cfg, mention) {
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
          content: `@${mention.handle} 说：${mention.text.slice(0, 500)}\n\n（原推：${mention.url}）\n\n请给出回复：`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${raw.slice(0, 200)}`);
  const text = JSON.parse(raw)?.choices?.[0]?.message?.content ?? '';
  return text.trim().replace(/^["'「]|["'」]$/g, '').slice(0, 200);
}

/**
 * 跑一轮：找新的 @ → 生成回复 → 用浏览器发出去。
 * @returns {{ matched: number, replied: number, skipped: number, details: string[] }}
 */
export async function processMentions(cfg, logger = console) {
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
  const fresh = mentions.filter(
    (m) => !state.handled[m.id] && Date.now() - m.createdAt < maxAge && whitelist.has(m.handle.toLowerCase()),
  );

  result.matched = fresh.length;
  if (!fresh.length) {
    state.lastCheck = Date.now();
    writeJson(mentionsStateFile(cfg), state);
    return result;
  }

  // 一轮只回一条，避免一次性刷屏
  const target = fresh[0];
  let text;
  try {
    text = await draftReply(cfg, target);
  } catch (err) {
    result.details.push(`生成回复失败：${err.message}`);
    return result;
  }

  logger.info?.(`回复 @${target.handle}：${text}`);

  try {
    const context = await launchContext({ dataDir: cfg.dataDir, headless: cfg.browserHeadless });
    try {
      await replyToTweet(context, target.url, text, { fast: true });
    } finally {
      await closeContext(context);
    }
    state.handled[target.id] = { at: Date.now(), handle: target.handle, text };
    result.replied += 1;
    result.details.push(`已回复 @${target.handle}（${target.url}）`);
  } catch (err) {
    result.details.push(`发送失败：${err.message}`);
  }

  state.lastCheck = Date.now();
  writeJson(mentionsStateFile(cfg), state);
  return result;
}

export { mentionsStateFile };

