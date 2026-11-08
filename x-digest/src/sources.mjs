import { setTimeout as sleep } from 'node:timers/promises';
import { loadSessionFromFile } from './xsession.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };

export function decodeText(s = '') {
  return String(s).replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 1e11) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mediaOf(tweet) {
  const media = tweet?.entities?.media ?? tweet?.extended_entities?.media ?? [];
  const urls = [];
  for (const m of media) {
    const url = m?.media_url_https ?? m?.media_url;
    if (url) urls.push(url);
  }
  for (const p of tweet?.photos ?? []) {
    const url = p?.url ?? p?.media_url_https;
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

/** 把 syndication / API 两种来源的 tweet 归一成内部结构。 */
export function normalizeTweet(tweet, fallbackHandle) {
  if (!tweet || typeof tweet !== 'object') return null;
  const id = String(tweet.id_str ?? tweet.id ?? '').trim();
  if (!id) return null;

  const author = tweet.user?.screen_name ?? tweet.author?.username ?? fallbackHandle ?? '';
  const text = decodeText(String(tweet.full_text ?? tweet.text ?? tweet.note_tweet?.text ?? '')).trim();
  const createdAt = toMs(tweet.created_at ?? tweet.createdAt ?? tweet.tweet_created_at);
  if (!text || !createdAt) return null;
  if (tweet.in_reply_to_status_id_str) return null; // 不刷回帖，噪音太大
  if (/^RT @/.test(text)) return null; // 不刷转推

  return {
    id,
    handle: author,
    text,
    createdAt,
    likes: Number(tweet.favorite_count ?? tweet.public_metrics?.like_count ?? 0) || 0,
    reposts: Number(tweet.retweet_count ?? tweet.public_metrics?.retweet_count ?? 0) || 0,
    replies: Number(tweet.reply_count ?? tweet.public_metrics?.reply_count ?? 0) || 0,
    images: mediaOf(tweet),
    url: `https://x.com/${author}/status/${id}`,
  };
}

/** 从任意 JSON 结构里挖出所有 tweet 对象（嵌套层级会变，所以递归找）。 */
function digTweets(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const item of node) digTweets(item, out, depth + 1);
    return out;
  }
  if (node.content?.tweet) out.push(node.content.tweet);
  else if (node.tweet && (node.tweet.id_str || node.tweet.id)) out.push(node.tweet);
  for (const key of ['entries', 'items', 'timeline', 'data', 'results', 'tweets']) {
    if (node[key]) digTweets(node[key], out, depth + 1);
  }
  return out;
}

async function getText(url, { timeoutMs, accept = 'text/html' }) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  const body = await res.text();
  return { status: res.status, ok: res.ok, body };
}

/** 来源一：X 自己的嵌入时间线（无需登录，公开数据）。 */
async function viaSyndication(handle, cfg) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(
    handle,
  )}?showReplies=false`;
  const { ok, status, body } = await getText(url, { timeoutMs: cfg.fetchTimeoutMs });
  if (!ok) throw new Error(`syndication HTTP ${status}`);

  const match = body.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('syndication 页面里没有 __NEXT_DATA__（可能改版或被拦）');
  const data = JSON.parse(match[1]);
  const raw = digTweets(data?.props?.pageProps ?? data);
  return raw.map((t) => normalizeTweet(t, handle)).filter(Boolean);
}

/** 来源二：cdn.syndication 的旧版 JSON 接口。 */
async function viaCdnSyndication(handle, cfg) {
  const url = `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(
    handle,
  )}&with_replies=false&include_available_features=1&include_entities=1`;
  const { ok, status, body } = await getText(url, { timeoutMs: cfg.fetchTimeoutMs, accept: 'application/json' });
  if (!ok) throw new Error(`cdn.syndication HTTP ${status}`);
  const parsed = JSON.parse(body);
  const inner = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed;
  const raw = digTweets(inner);
  return raw.map((t) => normalizeTweet(t, handle)).filter(Boolean);
}

async function apiGet(pathAndQuery, cfg, token) {
  const res = await fetch(`https://api.x.com${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'x-digest/0.1' },
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** 来源三：官方 API v2（需付费档的 Bearer token），最稳。 */
async function viaApi(handle, cfg) {
  const user = await apiGet(`/2/users/by/username/${encodeURIComponent(handle)}`, cfg, cfg.x.bearer);
  const id = user?.data?.id;
  if (!id) throw new Error(`找不到用户 @${handle}`);
  const tweets = await apiGet(
    `/2/users/${id}/tweets?max_results=${Math.min(Math.max(cfg.limitPerHandle, 5), 100)}` +
      '&exclude=retweets,replies&tweet.fields=created_at,public_metrics,entities',
    cfg,
    cfg.x.bearer,
  );
  return (tweets?.data ?? []).map((t) => normalizeTweet(t, handle)).filter(Boolean);
}

/**
 * 抓一个账号的时间线，按"先免费后付费"的顺序尝试来源。
 * @returns {Promise<{items: Array, source: string, error?: string}>}
 */
export async function fetchTimeline(handle, cfg) {
  const attempts = [['syndication', viaSyndication]];
  attempts.push(['cdn.syndication', viaCdnSyndication]);
  if (cfg.x.bearer) attempts.unshift(['api-v2', viaApi]);

  let lastError;
  for (const [name, fn] of attempts) {
    try {
      const items = await fn(handle, cfg);
      if (items.length) {
        items.sort((a, b) => b.createdAt - a.createdAt);
        return { items: items.slice(0, cfg.limitPerHandle), source: name };
      }
      lastError = new Error(`${name} 返回 0 条`);
    } catch (err) {
      lastError = err;
    }
  }
  return { items: [], source: 'none', error: lastError?.message ?? 'unknown' };
}

/** 并发抓多个账号，带一点间隔，避免瞬间打满。 */
export async function fetchAll(handles, cfg, { onItem } = {}) {
  const results = [];
  for (const handle of handles) {
    const result = await fetchTimeline(handle, cfg);
    results.push({ handle, ...result });
    onItem?.(handle, result);
    if (results.length < handles.length) await sleep(600 + Math.random() * 600);
  }
  return results;
}

/**
 * 用 cookie 会话读「你关注的账号」的时间线。
 *
 * 2026-11 实测：v1.1 的 home_timeline 已废（永远返回空），所以这里走 GraphQL
 * UserTweets，按 WATCH_HANDLES 逐个账号读 —— 结果反而更可控（只读你点名的人）。
 */
export async function fetchSessionTimeline(cfg, { count } = {}) {  const session = loadSessionFromFile(cfg);
  const handles = cfg.handles ?? [];
  if (!handles.length) throw new Error('WATCH_HANDLES 是空的，会话来源不知道读谁');

  const per = count ?? cfg.limitPerHandle ?? 20;
  const items = [];
  const errors = [];

  for (const handle of handles) {
    try {
      const got = await session.userTimeline(handle, { count: per });
      items.push(...got);
    } catch (err) {
      errors.push(`@${handle}: ${err.message}`);
    }
  }

  if (!items.length) {
    throw new Error(`会话读取失败：${errors.join('；') || '没有任何推文'}`);
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { items, source: 'session', errors };
}

/** 老 v2 timeline 格式（globalObjects）→ 内部结构。首页流和通知都用这套。 */
export function legacyTimelineToItems(body) {
  const tweets = body?.globalObjects?.tweets ?? {};
  const users = body?.globalObjects?.users ?? {};
  const out = [];

  for (const [key, t] of Object.entries(tweets)) {
    const text = t.full_text ?? t.text ?? '';
    if (!text) continue;
    if (t.in_reply_to_status_id_str) continue;
    if (/^RT @/.test(text)) continue;

    const id = String(t.id_str ?? key);
    const handle = users[t.user_id_str]?.screen_name ?? '';
    const createdAt = Number(t.created_at) || Date.parse(t.created_at ?? '') || 0;

    out.push({
      id,
      handle,
      text,
      createdAt,
      likes: Number(t.favorite_count ?? 0) || 0,
      reposts: Number(t.retweet_count ?? 0) || 0,
      replies: Number(t.reply_count ?? 0) || 0,
      images: [],
      url: `https://x.com/${handle || 'i'}/status/${id}`,
    });
  }

  return out;
}

/**
 * 首页推荐流（For You）。
 * ⚠️ 质量取决于这个账号平时刷什么——新号的推荐流可能是垃圾，用之前先看看。
 */
export async function fetchHomeTimeline(cfg, { count } = {}) {
  const session = loadSessionFromFile(cfg);
  const body = await session.homeTimeline({ count: count ?? cfg.limitPerHandle ?? 20 });
  const items = legacyTimelineToItems(body).sort((a, b) => b.createdAt - a.createdAt);
  if (!items.length) throw new Error('首页推荐流没读到可用的推文');
  return { items, source: 'home', errors: [] };
}

/**
 * 按关键词搜索（相当于「分区」）。
 * 用户在 SEARCH_QUERIES 里写话题，比如 `AI agent` / `DeepSeek` / `具身智能`。
 */
export async function fetchSearchTimeline(cfg, { count } = {}) {
  const session = loadSessionFromFile(cfg);
  const queries = (cfg.searchQueries ?? []).filter(Boolean);
  if (!queries.length) throw new Error('来源是「关键词搜索」，但 SEARCH_QUERIES 是空的');

  const per = count ?? cfg.limitPerHandle ?? 20;
  const items = [];
  const errors = [];

  for (const q of queries) {
    // 自动加赞数门槛（用户自己写了 min_faves 就不重复加）
    const withFloor = /min_faves:/i.test(q) || !cfg.searchMinLikes ? q : `${q} min_faves:${cfg.searchMinLikes}`;
    try {
      items.push(...(await session.search(withFloor, { count: per, product: cfg.searchProduct })));
    } catch (err) {
      errors.push(`「${q}」: ${err.message}`);
    }
  }

  if (!items.length) {
    throw new Error(`搜索没有结果：${errors.join('；') || '（关键词太窄？）'}`);
  }

  // 同一个推文可能被多个关键词命中，按 id 去重
  const seen = new Set();
  const unique = items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  unique.sort((a, b) => b.createdAt - a.createdAt);
  return { items: unique, source: 'search', errors };
}
