/**
 * OAuth 2.0 Authorization Code + PKCE。
 *
 * 为什么用它：新版 X 开发者控制台只给 OAuth 2.0 的 Client ID / Secret
 * （OAuth 1.0 那套只剩一个 Consumer Key，且拿不到 Secret）。
 *
 * 好处：可以拿 refresh token，access token 两小时过期后自动续，不用你反复授权。
 */

import { createHash, randomBytes } from 'node:crypto';

const AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const TOKEN = 'https://api.x.com/2/oauth2/token';

/** 需要的权限：读推文、发推、读用户、私信、离线续期 */
export const DEFAULT_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'dm.read', 'dm.write', 'offline.access'];

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ clientId, redirectUri, scopes = DEFAULT_SCOPES, state, codeChallenge }) {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function tokenRequest(body, { clientId, clientSecret }) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const detail = parsed?.error_description ?? parsed?.error ?? text.slice(0, 200);
    throw new Error(`OAuth2 token 请求失败：HTTP ${res.status} — ${detail}`);
  }
  if (!parsed?.access_token) throw new Error(`OAuth2 token 响应异常：${text.slice(0, 200)}`);
  return parsed;
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const parsed = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
    },
    { clientId, clientSecret },
  );
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? '',
    expiresAt: Date.now() + (Number(parsed.expires_in) || 7200) * 1000,
    scope: parsed.scope ?? '',
  };
}

export async function refreshToken({ clientId, clientSecret, refreshToken: token }) {
  const parsed = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: token, client_id: clientId },
    { clientId, clientSecret },
  );
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? token,
    expiresAt: Date.now() + (Number(parsed.expires_in) || 7200) * 1000,
    scope: parsed.scope ?? '',
  };
}
