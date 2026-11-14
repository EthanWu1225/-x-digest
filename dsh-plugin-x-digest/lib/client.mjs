import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8788';

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim() || DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/** $DSH_HOME/x-digest.json —— 不想改 patch 的话，把地址和 token 放这里就行。 */
export function readSidecarConfig(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'x-digest.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 配置优先级：插件 config > 环境变量 > $DSH_HOME/x-digest.json > 默认值。
 * 顺序反过来也说得通，但 patch 里显式写的值优先最好解释。
 */
export function resolveSettings(config = {}, env = process.env) {
  const sidecar = readSidecarConfig(env);
  const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim()) ?? '';

  const baseUrl = normalizeBaseUrl(
    pick(config.baseUrl, env.X_DIGEST_URL, sidecar.baseUrl, DEFAULT_BASE_URL),
  );
  const token = pick(config.token, env.X_DIGEST_TOKEN, sidecar.token);
  const defaultHandles = pick(config.defaultHandles, env.X_DIGEST_HANDLES, sidecar.defaultHandles);
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15000;

  return {
    baseUrl,
    token,
    timeoutMs,
    defaultHandles: defaultHandles
      .split(',')
      .map((s) => s.trim().replace(/^@/, ''))
      .filter(Boolean),
  };
}

export class XDigestError extends Error {}

export class XDigestClient {
  /**
   * @param {object} settings 初始配置
   * @param {() => object} [reload] 可选：每次请求前重新解析配置。
   *   sidecar（%USERPROFILE%\.dsh\x-digest.json）改完要立刻生效，就得靠它——
   *   否则配置只在插件挂载那一刻读一次，改了要重启 DSH。
   */
  constructor(settings, reload) {
    this.reload = typeof reload === 'function' ? reload : null;
    this.#apply(settings);
  }

  #apply(settings) {
    this.baseUrl = settings.baseUrl;
    this.token = settings.token;
    this.timeoutMs = settings.timeoutMs;
    this.defaultHandles = settings.defaultHandles ?? [];
  }

  #current() {
    if (!this.reload) return this;
    try {
      this.#apply(this.reload());
    } catch {
      /* 解析失败就用上一份 */
    }
    return this;
  }

  async #request(pathAndQuery, { auth = true, method = 'GET', body } = {}) {
    this.#current();
    const url = new URL(`${this.baseUrl}${pathAndQuery}`);
    if (auth && this.token) url.searchParams.set('token', this.token);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(this.token ? { 'x-digest-token': this.token } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new XDigestError(
        `连不上 x-digest 服务（${this.baseUrl}）：${err.message}。` +
          `先确认 VPS 上它活着，本机隧道开着（ssh -N -L 8788:127.0.0.1:8788 you@vps）。`,
      );
    }

    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    if (res.status === 401) {
      throw new XDigestError('x-digest 服务拒绝了请求：token 不对（检查 x-digest.json 或 patch 里的 token）');
    }
    if (!res.ok) {
      throw new XDigestError(
        `x-digest 返回 ${res.status}：${payload?.error ?? text.slice(0, 200)}`,
      );
    }
    if (!payload) throw new XDigestError(`x-digest 返回了非 JSON 内容：${text.slice(0, 200)}`);
    return payload;
  }

  async timeline({ handles, limit } = {}) {
    const list = (handles?.length ? handles : this.defaultHandles).filter(Boolean);
    const params = new URLSearchParams();
    if (list.length) params.set('handles', list.join(','));
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return this.#request(`/timeline${qs ? `?${qs}` : ''}`);
  }

  async digest({ dry = true, force = false } = {}) {
    const params = new URLSearchParams({ dry: dry ? '1' : '0', force: force ? '1' : '0' });
    return this.#request(`/digest?${params}`);
  }

  /** 待审草稿：回复 / 私信 / 发推都先落在这里，等人点「发」。 */
  async drafts({ status = 'pending' } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.#request(`/drafts${qs ? `?${qs}` : ''}`);
  }

  /** 审核一条草稿；approve 才会真的发出去。 */
  async review(id, action, reason = '') {
    return this.#request(`/drafts/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: { reason },
    });
  }

  /** 读服务端配置（设置页用）。 */
  async config() {
    return this.#request('/config');
  }

  /** 改服务端配置（会写进服务所在目录的 .env）。 */
  async saveConfig(patch) {
    return this.#request('/config', { method: 'POST', body: patch });
  }

  /** 读凭据状态（只返回"填没填"，不回传明文）。 */
  async credentials() {
    return this.#request('/credentials');
  }

  /** 写凭据：Client ID/Secret 进 .env，cookie 进 cookies 文件。 */
  async saveCredentials(patch) {
    return this.#request('/credentials', { method: 'POST', body: patch });
  }

  /** 生成 OAuth2 授权链接。 */
  async authStart() {
    return this.#request('/auth/start', { method: 'POST', body: {} });
  }

  /** 提交授权回调里的 code。 */
  async authFinish(code) {
    return this.#request('/auth/finish', { method: 'POST', body: { code } });
  }

  /** 读「@ 我」时的回复提示词（说话风格）。 */
  async prompt() {
    return this.#request('/prompt');
  }

  /** 保存提示词，下一轮生效。 */
  async savePrompt(text) {
    return this.#request('/prompt', { method: 'POST', body: { text } });
  }

  /** 立刻检查一次 @（不等轮询）。 */
  async mentionsCheck() {
    return this.#request('/mentions/check', { method: 'POST', body: {} });
  }

  /** 刷过的推文（含被敏感词挡掉的）。 */
  async history(limit = 30) {
    return this.#request(`/history?limit=${encodeURIComponent(limit)}`);
  }

  /** 分区预设（X 没有垂类分区，用调好的关键词组代替）。 */
  async presets() {
    return this.#request('/presets');
  }

  async health() {
    return this.#request('/health', { auth: false });
  }

  async state() {
    return this.#request('/state');
  }
}
