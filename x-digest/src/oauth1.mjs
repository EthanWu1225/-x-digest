import { createHmac, randomBytes } from 'node:crypto';

/**
 * X API v2 用 OAuth 1.0a User Context 发推时需要的最小签名实现。
 * 注意：请求体是 JSON 时，body 参数不参与签名（只有 oauth_* 与 query 参与）。
 */

export const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * OAuth 1.0a 的 signature base string。
 * @param {'GET'|'POST'} method
 * @param {string} url 不含 query 的绝对 URL
 * @param {Record<string,string>} params 已合并 oauth_* 与 query 的全部参数
 */
export function signatureBaseString(method, url, params) {
  const kv = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join('&');
  const urlObj = new URL(url);
  const origin = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  return [method.toUpperCase(), pct(origin), pct(kv)].join('&');
}

export function signOAuth(method, url, credentials, query = {}, { nonce, timestamp, extraOAuth } = {}) {
  const oauth = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
    // 三脚授权会额外带 oauth_callback / oauth_verifier，它们同样参与签名
    ...(extraOAuth ?? {}),
  };

  // request_token 阶段没有 access token：空串会让签名对不上，所以直接去掉
  if (!oauth.oauth_token) delete oauth.oauth_token;

  const signingParams = { ...query, ...oauth };
  const signingKey = `${pct(credentials.consumerSecret)}&${pct(credentials.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey)
    .update(signatureBaseString(method, url, signingParams))
    .digest('base64');

  return { ...oauth, oauth_signature: signature };
}

/**
 * @returns {string} 可直接放进 Authorization 头的字符串
 */
export function oauth1Header(method, url, credentials, query = {}, options) {
  const signed = signOAuth(method, url, credentials, query, options);
  return (
    'OAuth ' +
    Object.keys(signed)
      .sort()
      .map((k) => `${pct(k)}="${pct(signed[k])}"`)
      .join(', ')
  );
}
