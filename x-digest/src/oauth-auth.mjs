/**
 * OAuth 1.0a 三脚授权（3-legged）。
 *
 * 用途：开发者 App 建在主号名下，但我们想以**小号**身份发推。
 * 做法：用 App 的 consumer key/secret 走一次授权，让小号自己点「Authorize」，
 *      换回属于小号的 access token。这样发推身份就是小号，App 归属不影响。
 *
 * 两步式（不依赖本机回调服务）：
 *   1. npm run auth:start  → 打印一个授权链接，把 request token 暂存起来
 *   2. 浏览器里用**小号**登录并点 Authorize → 跳转到 callback，地址栏里带 oauth_verifier
 *   3. npm run auth:finish -- <oauth_verifier> → 换成 access token 存进 data/x-tokens.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { signOAuth } from './oauth1.mjs';

const API = 'https://api.x.com';

/** 请求 token（第一步）。accessToken 传空串即可。 */
export async function requestToken({ consumerKey, consumerSecret, callback }, { baseUrl = API } = {}) {
  const url = `${baseUrl}/oauth/request_token`;
  const signed = signOAuth(
    'POST',
    url,
    { consumerKey, consumerSecret, accessToken: '', accessTokenSecret: '' },
    {},
    { extraOAuth: { oauth_callback: callback } },
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: headerOf(signed) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`request_token 失败：HTTP ${res.status} ${text.slice(0, 200)}`);

  const params = new URLSearchParams(text);
  const token = params.get('oauth_token');
  const secret = params.get('oauth_token_secret');
  const confirmed = params.get('oauth_callback_confirmed');
  if (!token) throw new Error(`request_token 返回异常：${text.slice(0, 200)}`);
  if (confirmed !== 'true') throw new Error(`X 没有确认回调地址（oauth_callback_confirmed=${confirmed}）`);
  return { token, secret, authorizeUrl: `${baseUrl}/oauth/authorize?oauth_token=${token}` };
}

/** 换取 access token（第三步）。 */
export async function exchangeToken(
  { consumerKey, consumerSecret, requestToken: reqToken, requestSecret, verifier },
  { baseUrl = API } = {},
) {
  const url = `${baseUrl}/oauth/access_token`;
  const signed = signOAuth(
    'POST',
    url,
    { consumerKey, consumerSecret, accessToken: reqToken, accessTokenSecret: requestSecret },
    {},
    { extraOAuth: { oauth_verifier: verifier } },
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: headerOf(signed) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `access_token 失败：HTTP ${res.status} ${text.slice(0, 200)}` +
        '（最常见原因：verifier 用过了 / 15 分钟内过期 / 复制缺字符）',
    );
  }

  const params = new URLSearchParams(text);
  const token = params.get('oauth_token');
  const secret = params.get('oauth_token_secret');
  if (!token) throw new Error(`access_token 返回异常：${text.slice(0, 200)}`);
  return {
    accessToken: token,
    accessTokenSecret: secret,
    screenName: params.get('screen_name') ?? '',
    userId: params.get('user_id') ?? '',
  };
}

function headerOf(signed) {
  return (
    'OAuth ' +
    Object.keys(signed)
      .sort()
      .map((k) => `${pct(k)}="${pct(signed[k])}"`)
      .join(', ')
  );
}

const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** 暂存 request token（第二步之前需要它）。 */
export function savePending(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function loadPending(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
