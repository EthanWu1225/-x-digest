/**
 * 宿主半侧的 HTTP 路由：/api/x-digest/*
 *
 * 为什么需要它：浏览器里的设置页和 DSH 页面同源，只能访问宿主的接口；
 * 它没法直接跨域去调用 127.0.0.1:8788。所以这里做一层薄代理。
 */

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
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

/**
 * @param {any} ctx 插件上下文
 * @param {any} client XDigestClient（每个请求现读配置）
 * @param {{info?:Function, warn?:Function, error?:Function}} logger
 */
export function registerRoutes(ctx, client, logger) {
  // 访问未提供的服务可能抛错，所以单独兜一层：设置页不可用绝不能影响工具注册
  let webServer;
  try {
    webServer = ctx?.webServer;
  } catch {
    webServer = null;
  }
  if (typeof webServer?.register !== 'function') {
    logger?.warn?.('宿主没有 webServer 服务，设置页接口不可用（工具仍然可用）');
    return;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '');

    try {
      // 设置页一次性拿全：配置 + 状态
      if (path === '/api/x-digest/state' && req.method === 'GET') {
        let config = null;
        let health = null;
        let state = null;
        const errors = [];

        try {
          config = await client.config();
        } catch (err) {
          errors.push(`config: ${err.message}`);
        }
        try {
          health = await client.health();
        } catch (err) {
          errors.push(`health: ${err.message}`);
        }
        if (config) {
          try {
            state = await client.state();
          } catch (err) {
            errors.push(`state: ${err.message}`);
          }
        }

        return json(res, 200, {
          ok: errors.length === 0,
          online: Boolean(health?.ok),
          baseUrl: client.baseUrl,
          config,
          health,
          state,
          errors,
        });
      }

      if (path === '/api/x-digest/config' && req.method === 'POST') {
        const patch = await readJson(req);
        const result = await client.saveConfig(patch);
        return json(res, 200, { ok: true, ...result });
      }

      if (path === '/api/x-digest/credentials' && req.method === 'GET') {
        return json(res, 200, await client.credentials());
      }

      if (path === '/api/x-digest/credentials' && req.method === 'POST') {
        const patch = await readJson(req);
        return json(res, 200, await client.saveCredentials(patch));
      }

      if (path === '/api/x-digest/auth/start' && req.method === 'POST') {
        return json(res, 200, await client.authStart());
      }

      if (path === '/api/x-digest/auth/finish' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, await client.authFinish(String(body?.code ?? '')));
      }

      if (path === '/api/x-digest/prompt' && req.method === 'GET') {
        return json(res, 200, await client.prompt());
      }

      if (path === '/api/x-digest/prompt' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, await client.savePrompt(String(body?.text ?? '')));
      }

      if (path === '/api/x-digest/mentions/check' && req.method === 'POST') {
        return json(res, 200, await client.mentionsCheck());
      }

      if (path === '/api/x-digest/history' && req.method === 'GET') {
        return json(res, 200, await client.history(url.searchParams.get('limit') ?? 30));
      }

      if (path === '/api/x-digest/presets' && req.method === 'GET') {
        return json(res, 200, await client.presets());
      }

      // 手动跑一轮（默认干跑，不会真的发）
      if (path === '/api/x-digest/run' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const dry = body?.dry !== false;
        const result = await client.digest({ dry, force: body?.force === true });
        return json(res, 200, { ok: true, dry, result });
      }

      return json(res, 404, { ok: false, error: `unknown ${req.method} ${path}` });
    } catch (err) {
      logger?.warn?.(`/api/x-digest 出错：${err.message}`);
      return json(res, 502, { ok: false, error: err.message });
    }
  };

  try {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: '/api/x-digest', handler }),
      'x-digest: /api/x-digest 路由',
    );
  } catch (err) {
    logger?.error?.(`x-digest 路由没挂上：${err.message}`);
  }
}
