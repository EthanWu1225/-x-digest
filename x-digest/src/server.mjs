import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadState, pruneState, saveState } from './state.mjs';
import { runCycle, readInterests } from './digest.mjs';
import { fetchAll } from './sources.mjs';
import { whoami } from './xpost.mjs';
import { loadSessionFromFile, XSessionError } from './xsession.mjs';
import { loadQueue, saveQueue, addDraft, listDrafts, approveDraft, rejectDraft } from './drafts.mjs';
import { patchEnvFile, patchEnvKeys } from './envfile.mjs';
import { createPkcePair, buildAuthorizeUrl, exchangeCode } from './oauth2.mjs';
import { savePending, loadPending } from './oauth-auth.mjs';
import { saveTokens, tokensFile, loadTokens } from './tokens.mjs';
import { processMentions, readReplyPrompt, promptFile } from './mentions.mjs';
import { loadHistory } from './history.mjs';

/** 只显示尾部几位，确认"填过没有"而不泄露。 */
const tail = (s) => (s ? `…${String(s).slice(-4)}` : '');

function readCookies(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeCookies(file, cookies) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cookies, null, 2), 'utf8');
}

/**
 * 把设置页的改动写进 .env，并同步内存里的 cfg —— 不用重启服务。
 */
function saveEnvPatch(cfg, patch = {}) {
  const changed = patchEnvFile(cfg.envFile, patch);

  if (Object.hasOwn(patch, 'source')) cfg.source = String(patch.source).toLowerCase();
  if (Object.hasOwn(patch, 'searchQueries')) {
    cfg.searchQueries = String(patch.searchQueries ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Object.hasOwn(patch, 'searchProduct')) cfg.searchProduct = String(patch.searchProduct);
  if (Object.hasOwn(patch, 'searchMinLikes')) cfg.searchMinLikes = Number(patch.searchMinLikes) || cfg.searchMinLikes;

  if (Object.hasOwn(patch, 'watchHandles')) {    cfg.handles = String(patch.watchHandles ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^@/, ''))
      .filter(Boolean);
  }
  if (Object.hasOwn(patch, 'targetHandle')) {
    cfg.targetHandle = String(patch.targetHandle ?? '').trim().replace(/^@/, '');
  }
  if (Object.hasOwn(patch, 'postMode')) cfg.postMode = String(patch.postMode).trim();
  if (Object.hasOwn(patch, 'maxPicks')) cfg.maxPicks = Number(patch.maxPicks) || cfg.maxPicks;
  if (Object.hasOwn(patch, 'maxPostsPerDay')) cfg.maxPostsPerDay = Number(patch.maxPostsPerDay) || cfg.maxPostsPerDay;
  if (Object.hasOwn(patch, 'minIntervalMinutes')) cfg.minIntervalMinutes = Number(patch.minIntervalMinutes) || cfg.minIntervalMinutes;
  if (Object.hasOwn(patch, 'pollIntervalMinutes')) cfg.pollIntervalMinutes = Number(patch.pollIntervalMinutes) || cfg.pollIntervalMinutes;
  if (Object.hasOwn(patch, 'mentionWatch')) cfg.mentionWatch = String(patch.mentionWatch).toLowerCase() === 'true';
  if (Object.hasOwn(patch, 'mentionPollMinutes')) cfg.mentionPollMinutes = Number(patch.mentionPollMinutes) || cfg.mentionPollMinutes;
  if (Object.hasOwn(patch, 'mentionWhitelist')) {
    const list = String(patch.mentionWhitelist ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^@/, ''))
      .filter(Boolean);
    cfg.mentionWhitelist = list.length ? list : cfg.targetHandle ? [cfg.targetHandle] : [];
  }

  return changed;
}

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function authorized(req, cfg, url) {
  if (!cfg.server.token) return true;
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const header = req.headers['x-digest-token'];
  const query = url?.searchParams.get('token');
  return bearer === cfg.server.token || header === cfg.server.token || query === cfg.server.token;
}

/**
 * 起一个只给自己用的小 HTTP 接口 + 内部定时器。
 * 用途一：让 VPS 自己定时跑；用途二：让 DSH 里的 agent 能查 X（GET /timeline）。
 */
export function startServer(cfg, logger) {
  const state = { lastRun: 0, running: false };

  const run = async (opts) => {
    if (state.running) return { skipped: '上一轮还在跑' };
    state.running = true;
    try {
      return await runCycle(cfg, { ...opts, logger });
    } finally {
      state.running = false;
      state.lastRun = Date.now();
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health') {
      return json(res, 200, {
        ok: true,
        handles: cfg.handles,
        postMode: cfg.postMode,
        canPost: cfg.canPost,
        pollIntervalMinutes: cfg.pollIntervalMinutes,
        lastRunAt: state.lastRun ? new Date(state.lastRun).toISOString() : null,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (!authorized(req, cfg, url)) return json(res, 401, { error: 'unauthorized' });

    try {
      if (pathname === '/timeline' && req.method === 'GET') {
        const handles = (url.searchParams.get('handles') ?? cfg.handles.join(','))
          .split(',')
          .map((s) => s.trim().replace(/^@/, ''))
          .filter(Boolean);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 60);
        const results = await fetchAll(handles, cfg);
        return json(res, 200, {
          handles,
          items: results.flatMap((r) =>
            r.items.slice(0, limit).map((i) => ({ ...i, handle: i.handle || r.handle })),
          ),
          errors: results.filter((r) => r.error).map((r) => ({ handle: r.handle, error: r.error })),
        });
      }

      if (pathname === '/state' && req.method === 'GET') {
        const s = loadState(cfg.paths.state);
        return json(res, 200, {
          seen: Object.keys(s.seen ?? {}).length,
          posts: s.posts ?? [],
          lastRunAt: s.lastRunAt,
          lastPostAt: s.lastPostAt,
          lastError: s.lastError,
        });
      }

      if (pathname === '/digest' && (req.method === 'GET' || req.method === 'POST')) {
        const dry = url.searchParams.get('dry') === '1' || url.searchParams.get('dry') === 'true';
        const force = url.searchParams.get('force') === '1';
        const result = await run({ dry, force });
        return json(res, 200, result);
      }

      if (pathname === '/whoami' && req.method === 'GET') {
        return json(res, 200, await whoami(cfg));
      }

      // —— 配置读写（给 DSH 设置页用）——
      if (pathname === '/config' && req.method === 'GET') {
        return json(res, 200, {
          source: cfg.source,
          searchQueries: cfg.searchQueries.join(','),
          searchProduct: cfg.searchProduct,
          searchMinLikes: cfg.searchMinLikes,
          watchHandles: cfg.handles.join(','),
          targetHandle: cfg.targetHandle,
          postMode: cfg.postMode,
          maxPicks: cfg.maxPicks,
          maxPostsPerDay: cfg.maxPostsPerDay,
          minIntervalMinutes: cfg.minIntervalMinutes,
          pollIntervalMinutes: cfg.pollIntervalMinutes,
          mentionWatch: cfg.mentionWatch,
          mentionPollMinutes: cfg.mentionPollMinutes,
          mentionWhitelist: cfg.mentionWhitelist.join(','),
          actingAs: cfg.actingAs ?? '',
          canPost: cfg.canPost,
          hasCookies: existsSync(cfg.session.cookiesFile),
          timeZone: cfg.timeZone,
        });
      }

      if (pathname === '/config' && req.method === 'POST') {
        const patch = await readJson(req);
        const changed = saveEnvPatch(cfg, patch);
        return json(res, 200, { ok: true, changed });
      }

      // —— 接入凭据（设置页那几张输入框）——
      const credentialsView = () => ({
        clientIdSet: Boolean(cfg.oauth2.clientId),
        clientIdTail: tail(cfg.oauth2.clientId),
        clientSecretSet: Boolean(cfg.oauth2.clientSecret),
        clientSecretTail: tail(cfg.oauth2.clientSecret),
        cookiesSet: existsSync(cfg.session.cookiesFile),
        canPost: cfg.canPost,
        actingAs: cfg.actingAs ?? '',
        redirectUri: cfg.oauth2.redirectUri,
      });

      if (pathname === '/credentials' && req.method === 'GET') {
        return json(res, 200, credentialsView());
      }

      if (pathname === '/credentials' && req.method === 'POST') {
        const body = await readJson(req);
        const changed = [];

        if (body.clientId || body.clientSecret) {
          const pairs = {};
          if (body.clientId) {
            pairs.X_CLIENT_ID = String(body.clientId).trim();
            cfg.oauth2.clientId = pairs.X_CLIENT_ID;
          }
          if (body.clientSecret) {
            pairs.X_CLIENT_SECRET = String(body.clientSecret).trim();
            cfg.oauth2.clientSecret = pairs.X_CLIENT_SECRET;
          }
          changed.push(...patchEnvKeys(cfg.envFile, pairs));
        }

        if (body.authToken || body.ct0) {
          const cookies = readCookies(cfg.session.cookiesFile);
          if (body.authToken) cookies.auth_token = String(body.authToken).trim();
          if (body.ct0) cookies.ct0 = String(body.ct0).trim();
          writeCookies(cfg.session.cookiesFile, cookies);
          changed.push('cookies');
        }

        // 控制台直接生成的 Access Token / Refresh Token（不用三脚授权）
        if (body.accessToken) {
          const previous = loadTokens(tokensFile(cfg.dataDir)) ?? {};
          const next = {
            ...previous,
            accessToken: String(body.accessToken).trim(),
            refreshToken: String(body.refreshToken ?? previous.refreshToken ?? '').trim(),
            expiresAt: Number(body.expiresIn) > 0 ? Date.now() + Number(body.expiresIn) * 1000 : previous.expiresAt ?? 0,
            obtainedAt: Date.now(),
          };
          saveTokens(tokensFile(cfg.dataDir), next);

          cfg.oauth2.accessToken = next.accessToken;
          cfg.oauth2.refreshToken = next.refreshToken;
          cfg.oauth2.expiresAt = next.expiresAt;
          changed.push('accessToken');
        }

        cfg.canPost = Boolean(cfg.oauth2.clientId && cfg.oauth2.clientSecret && cfg.oauth2.accessToken);
        return json(res, 200, { ok: true, changed, ...credentialsView() });
      }

      // —— OAuth2 授权：拿链接 / 提交 code ——
      if (pathname === '/auth/start' && req.method === 'POST') {
        if (!cfg.oauth2.clientId || !cfg.oauth2.clientSecret) {
          return json(res, 400, { ok: false, error: '先填 Client ID 和 Client Secret' });
        }
        const { verifier, challenge } = createPkcePair();
        const state = randomBytes(8).toString('hex');
        const authorizeUrl = buildAuthorizeUrl({
          clientId: cfg.oauth2.clientId,
          redirectUri: cfg.oauth2.redirectUri,
          state,
          codeChallenge: challenge,
        });
        savePending(path.join(cfg.dataDir, 'oauth-pending.json'), {
          verifier,
          state,
          redirectUri: cfg.oauth2.redirectUri,
          createdAt: Date.now(),
        });
        return json(res, 200, { ok: true, authorizeUrl, redirectUri: cfg.oauth2.redirectUri });
      }

      if (pathname === '/auth/finish' && req.method === 'POST') {
        const body = await readJson(req);
        const code = String(body.code ?? '').trim();
        if (!code) return json(res, 400, { ok: false, error: '缺少 code' });

        const pending = loadPending(path.join(cfg.dataDir, 'oauth-pending.json'));
        if (!pending?.verifier) return json(res, 400, { ok: false, error: '没有待授权的记录，先点「生成授权链接」' });

        const tokens = await exchangeCode({
          clientId: cfg.oauth2.clientId,
          clientSecret: cfg.oauth2.clientSecret,
          code,
          redirectUri: pending.redirectUri,
          codeVerifier: pending.verifier,
        });

        const probeCfg = { ...cfg, oauth2: { ...cfg.oauth2, ...tokens } };
        const me = await whoami(probeCfg).catch(() => null);

        saveTokens(tokensFile(cfg.dataDir), { ...tokens, screenName: me?.username ?? '', obtainedAt: Date.now() });
        cfg.oauth2.accessToken = tokens.accessToken;
        cfg.oauth2.refreshToken = tokens.refreshToken;
        cfg.oauth2.expiresAt = tokens.expiresAt;
        cfg.actingAs = me?.username ?? cfg.actingAs;
        cfg.canPost = Boolean(cfg.oauth2.clientId && cfg.oauth2.clientSecret && cfg.oauth2.accessToken);

        return json(res, 200, { ok: true, screenName: me?.username ?? '', ...credentialsView() });
      }

      // —— 手动检查 @ 提及（调试或想立刻回一条时用）——
      if (pathname === '/mentions/check' && (req.method === 'POST' || req.method === 'GET')) {
        const result = await processMentions(cfg, logger);
        return json(res, 200, result);
      }

      // —— 刷过的推文 ——
      if (pathname === '/history' && req.method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
        const history = loadHistory(cfg);
        const items = history.items.slice(0, limit);
        return json(res, 200, {
          total: history.items.length,
          counts: items.reduce((acc, i) => {
            acc[i.action] = (acc[i.action] ?? 0) + 1;
            return acc;
          }, {}),
          items,
        });
      }

      if (pathname === '/interests' && req.method === 'GET') {        return json(res, 200, { text: readInterests(cfg) });
      }

      // —— 回复提示词（说话风格）——
      if (pathname === '/prompt' && req.method === 'GET') {
        return json(res, 200, { text: readReplyPrompt(cfg), file: promptFile(cfg) });
      }

      if (pathname === '/prompt' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text ?? '');
        if (!text.trim()) return json(res, 400, { ok: false, error: '提示词不能为空' });
        const file = promptFile(cfg);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text, 'utf8');
        return json(res, 200, { ok: true, file, length: text.length });
      }

      // —— 互动层：cookie 会话 ——
      if (pathname === '/session/me' && req.method === 'GET') {
        try {
          const me = await loadSessionFromFile(cfg).verify();
          return json(res, 200, me);
        } catch (err) {
          const status = err instanceof XSessionError ? 400 : 500;
          return json(res, status, { error: err.message });
        }
      }

      if (pathname === '/session/probe' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          return json(res, 200, await loadSessionFromFile(cfg).probe());
        } catch (err) {
          const status = err instanceof XSessionError ? 400 : 500;
          return json(res, status, { error: err.message });
        }
      }

      // —— 审核队列 ——
      if (pathname === '/drafts' && req.method === 'GET') {
        const queue = loadQueue(cfg.paths.queue);
        const status = url.searchParams.get('status') ?? '';
        return json(res, 200, {
          items: listDrafts(queue, status ? { status } : {}),
          counts: {
            pending: listDrafts(queue, { status: 'pending' }).length,
            sent: listDrafts(queue, { status: 'sent' }).length,
            rejected: listDrafts(queue, { status: 'rejected' }).length,
            failed: listDrafts(queue, { status: 'failed' }).length,
          },
        });
      }

      if (pathname === '/drafts' && req.method === 'POST') {
        const body = await readJson(req);
        const queue = loadQueue(cfg.paths.queue);
        const item = addDraft(queue, {
          kind: body.kind ?? 'tweet',
          text: body.text,
          target: body.target,
          reason: body.reason,
        });
        saveQueue(cfg.paths.queue, queue);
        return json(res, 200, item);
      }

      const draftAction = /^\/drafts\/([^/]+)\/(approve|reject)$/.exec(pathname);
      if (draftAction && req.method === 'POST') {
        const [, id, action] = draftAction;
        const queue = loadQueue(cfg.paths.queue);

        if (action === 'reject') {
          const body = await readJson(req).catch(() => ({}));
          const item = rejectDraft(queue, id, body.reason ?? '人工驳回');
          saveQueue(cfg.paths.queue, queue);
          return json(res, 200, item);
        }

        let session;
        try {
          session = loadSessionFromFile(cfg);
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        try {
          const item = await approveDraft(queue, id, session, {
            timeZone: cfg.timeZone,
            replyDailyLimit: cfg.session.replyDailyLimit,
            dmDailyLimit: cfg.session.dmDailyLimit,
          });
          saveQueue(cfg.paths.queue, queue);
          return json(res, 200, item);
        } catch (err) {
          saveQueue(cfg.paths.queue, queue); // 失败状态也要落盘
          const status = err instanceof XSessionError ? 502 : 400;
          return json(res, status, { error: err.message });
        }
      }

      return json(res, 404, { error: `no route: ${req.method} ${pathname}` });
    } catch (err) {
      logger.error(`接口出错 ${pathname}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  });

  server.listen(cfg.server.port, cfg.server.host, () => {
    logger.info(`监听 http://${cfg.server.host}:${cfg.server.port}（token ${cfg.server.token ? '已启用' : '未设置'}）`);
  });

  const tickMs = 30_000;
  const intervalMs = cfg.pollIntervalMinutes * 60_000;
  const timer = setInterval(async () => {
    if (state.running) return;
    if (Date.now() - state.lastRun < intervalMs) return;
    logger.info('定时触发一轮');
    try {
      const result = await run({ dry: false });
      if (result.text) logger.debug(result.text);
    } catch (err) {
      logger.error(`定时任务异常：${err.message}`);
    }
  }, tickMs);
  timer.unref?.();

  const prune = setInterval(() => {    try {
      const s = loadState(cfg.paths.state);
      saveState(cfg.paths.state, pruneState(s));
    } catch {
      /* ignore */
    }
  }, 6 * 3600_000);
  prune.unref?.();

  // —— 监听 @ 我的提及 ——
  const mentionTimer = cfg.mentionWatch
    ? setInterval(
        async () => {
          try {
            const r = await processMentions(cfg, logger);
            if (r.replied > 0) logger.info(`提及回复完成：${r.details.join('；')}`);
          } catch (err) {
            logger.error(`提及检查异常：${err.message}`);
          }
        },
        Math.max(1, cfg.mentionPollMinutes) * 60_000,
      )
    : null;
  mentionTimer?.unref?.();

  const close = () =>
    new Promise((resolve) => {
      clearInterval(timer);
      clearInterval(prune);
      if (mentionTimer) clearInterval(mentionTimer);
      server.close(() => resolve());
    });

  return { server, close, run };
}

