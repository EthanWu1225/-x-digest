import { oauth1Header } from './oauth1.mjs';
import { fetchTimeline } from './sources.mjs';
import { refreshToken as refreshOAuth2 } from './oauth2.mjs';
import { loadTokens, saveTokens, tokensFile } from './tokens.mjs';

const API = 'https://api.x.com';

function creds(cfg) {
  return {
    consumerKey: cfg.x.consumerKey,
    consumerSecret: cfg.x.consumerSecret,
    accessToken: cfg.x.accessToken,
    accessTokenSecret: cfg.x.accessTokenSecret,
  };
}

/** OAuth2 的 access token 只有两小时，快过期就用 refresh token 续一次。 */
async function ensureBearer(cfg) {
  if (!cfg.oauth2?.accessToken) return null;
  const expiresAt = Number(cfg.oauth2.expiresAt) || 0;
  const expiringSoon = expiresAt > 0 && Date.now() > expiresAt - 120_000;
  if (!expiringSoon || !cfg.oauth2.refreshToken) return cfg.oauth2.accessToken;

  const refreshed = await refreshOAuth2({
    clientId: cfg.oauth2.clientId,
    clientSecret: cfg.oauth2.clientSecret,
    refreshToken: cfg.oauth2.refreshToken,
  });

  cfg.oauth2.accessToken = refreshed.accessToken;
  cfg.oauth2.refreshToken = refreshed.refreshToken;
  cfg.oauth2.expiresAt = refreshed.expiresAt;

  const file = tokensFile(cfg.dataDir);
  const previous = loadTokens(file) ?? {};
  saveTokens(file, { ...previous, ...refreshed, screenName: previous.screenName ?? cfg.oauth2.screenName });
  return refreshed.accessToken;
}

async function call(method, pathAndQuery, cfg, body) {
  const url = new URL(`${API}${pathAndQuery}`);
  const bearer = await ensureBearer(cfg);

  const headers = {
    'user-agent': 'x-digest/0.1',
    ...(bearer
      ? { authorization: `Bearer ${bearer}` }
      : {
          authorization: oauth1Header(
            method,
            `${API}${url.pathname}`,
            creds(cfg),
            Object.fromEntries(url.searchParams),
          ),
        }),
    ...(body ? { 'content-type': 'application/json' } : {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs ?? 20000),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json?.detail ?? json?.title ?? json?.errors?.[0]?.message ?? text.slice(0, 300);
    const err = new Error(`X API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** 当前 token 属于哪个账号（也是发推凭据的第一道验证）。 */
export async function whoami(cfg) {
  const me = await call('GET', '/2/users/me?user.fields=username,name,public_metrics', cfg);
  return me?.data ?? null;
}

/** 发一条推。replyTo 给了就是回复。 */
export async function postTweet(cfg, text, { replyTo } = {}) {
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
  const res = await call('POST', '/2/tweets', cfg, body);
  const data = res?.data;
  if (!data?.id) throw new Error(`发推返回异常：${JSON.stringify(res).slice(0, 300)}`);
  return data;
}

/** 发私信（需要 dm.write 权限，且收件人必须是数字 id）。 */
export async function sendDm(cfg, userId, text) {
  const body = { text };
  const res = await call('POST', `/2/dm_conversations/with/${encodeURIComponent(userId)}/messages`, cfg, body);
  return res?.data ?? res;
}

/** 目标账号最近一条推（带时间），用于判断值不值得回复。有会话走 GraphQL，否则退回匿名来源。 */
export async function latestTweet(handle, cfg, session) {
  if (session) {
    const items = await session.userTimeline(handle, { count: 5 });
    return items[0] ?? null;
  }
  const { items } = await fetchTimeline(handle, cfg);
  return items[0] ?? null;
}

/** 只要 id 的版本。 */
export async function latestTweetId(handle, cfg, session) {
  const tweet = await latestTweet(handle, cfg, session);
  return tweet?.id ?? null;
}
