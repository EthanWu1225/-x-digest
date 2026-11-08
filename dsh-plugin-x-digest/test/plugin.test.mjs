import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import './hooks.mjs';

const { Context } = await import('@deepseek-ai/cordis');
const { assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools');
const plugin = await import('../lib/index.js');
const { resolveSettings } = await import('../lib/client.mjs');

/** 假的 x-digest 服务：记录收到的请求，按路由回固定 JSON。 */
async function startFakeService() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, token: url.searchParams.get('token') });

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/health') {
      return send(200, { ok: true, handles: ['sama', 'karpathy'], postMode: 'reply', canPost: true });
    }
    if (url.pathname === '/state') {
      return send(200, {
        seen: 42,
        posts: [{ ts: Date.now() - 3600_000, id: '111' }],
        lastPostAt: Date.now() - 3600_000,
        lastError: null,
      });
    }
    if (url.pathname === '/timeline') {
      return send(200, {
        handles: (url.searchParams.get('handles') ?? '').split(',').filter(Boolean),
        items: [
          {
            id: '999',
            handle: 'sama',
            text: 'shipping  something   new',
            createdAt: Date.now() - 90 * 60_000,
            likes: 12,
            reposts: 3,
            url: 'https://x.com/sama/status/999',
          },
        ],
        errors: [],
      });
    }
    if (url.pathname === '/digest') {
      return send(200, {
        skipped: 'dry-run',
        picks: [{ id: '999', handle: 'sama', reason: '有新东西', url: 'https://x.com/sama/status/999' }],
        text: '@me 这几条我觉得你会想看：\n\n1. @sama：有新东西 https://x.com/sama/status/999',
        posted: null,
        errors: [],
      });
    }
    if (/^\/drafts\/[^/]+\/(approve|reject)$/.test(url.pathname)) {
      const sent = url.pathname.endsWith('/approve');
      return send(200, {
        id: 'd1',
        status: sent ? 'sent' : 'rejected',
        resultId: sent ? '555' : '',
        error: '',
      });
    }
    if (url.pathname === '/drafts') {
      return send(200, {
        items: [
          {
            id: 'd1',
            kind: 'reply',
            text: '这条值得回一句',
            target: { id: '900', handle: 'sama', url: 'https://x.com/sama/status/900' },
            reason: '他问了个具体问题',
            status: 'pending',
            createdAt: Date.now() - 60_000,
          },
        ],
        counts: { pending: 1, sent: 0, rejected: 0, failed: 0 },
      });
    }
    return send(404, { error: 'no route' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 用一个假的 tools 注册表把插件挂进真实 Cordis 上下文。 */
async function mountPlugin(config) {
  const registry = new Map();
  const ctx = new Context();
  ctx.provide('tools'); // cordis 要求先声明再赋值
  ctx.set('tools', {
    register: (definition) => registry.set(definition.name, definition),
    get: (toolName) => registry.get(toolName),
  });
  ctx.plugin(plugin, config);

  for (let i = 0; i < 50 && registry.size < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { ctx, registry };
}

test('插件在真实 Cordis 上下文里注册出三个工具', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 'secret-token' });
  try {
    assert.deepEqual([...registry.keys()].sort(), [
      'x_digest_now',
      'x_digest_status',
      'x_drafts',
      'x_review',
      'x_timeline',
    ]);
    for (const def of registry.values()) {
      assert.equal(typeof def.execute, 'function', `${def.name} 缺少 execute`);
      assert.equal(typeof def.description, 'string');
    }
  } finally {
    await fake.close();
  }
});

test('x_timeline：把服务返回整理成模型能直接用的形状，并带上 token', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 'secret-token' });
  try {
    const def = registry.get('x_timeline');
    const value = await def.execute({ handles: '@sama, karpathy', limit: 5 }, {});

    assert.deepEqual(value.handles, ['sama', 'karpathy']);
    assert.equal(value.items.length, 1);
    assert.equal(value.items[0].text, 'shipping something new');
    assert.equal(value.items[0].ageMinutes, 90);
    assert.deepEqual(value.errors, []);
    assert.equal(fake.requests.at(-1).token, 'secret-token');
  } finally {
    await fake.close();
  }
});

test('x_digest_now：默认 dry，透传 force，解析出 picks 与文案', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  try {
    const def = registry.get('x_digest_now');
    const value = await def.execute({}, {});
    assert.equal(value.skipped, 'dry-run');
    assert.equal(value.picked, 1);
    assert.equal(value.picks[0].handle, 'sama');
    assert.ok(value.text.startsWith('@me'));
    assert.equal(value.postedId, '');
  } finally {
    await fake.close();
  }
});

test('x_digest_status：服务在线时汇总状态，离线时降级而不抛错', async () => {
  const fake = await startFakeService();
  const online = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  const live = await online.registry.get('x_digest_status').execute({}, {});
  assert.equal(live.online, true);
  assert.deepEqual(live.handles, ['sama', 'karpathy']);
  assert.equal(live.postMode, 'reply');
  assert.equal(live.seen, 42);
  await fake.close();

  const offline = await mountPlugin({ baseUrl: 'http://127.0.0.1:9', token: 't', timeoutMs: 500 });
  const dead = await offline.registry.get('x_digest_status').execute({}, {});
  assert.equal(dead.online, false);
  assert.ok(dead.lastError.length > 0);
});

test('resolveSettings：config > 环境变量 > sidecar > 默认值', () => {
  const env = { DSH_HOME: 'C:\\does-not-exist', X_DIGEST_URL: 'https://env.example', X_DIGEST_TOKEN: 'envtok' };
  const fromEnv = resolveSettings({}, env);
  assert.equal(fromEnv.baseUrl, 'https://env.example');
  assert.equal(fromEnv.token, 'envtok');

  const fromConfig = resolveSettings({ baseUrl: '10.0.0.2:9000', token: 'cfgtok' }, env);
  assert.equal(fromConfig.baseUrl, 'http://10.0.0.2:9000', '没写协议时要补 http://');
  assert.equal(fromConfig.token, 'cfgtok', 'config 要压过环境变量');

  const fallback = resolveSettings({}, { DSH_HOME: 'C:\\does-not-exist' });
  assert.equal(fallback.baseUrl, 'http://127.0.0.1:8788');
});

test('description 里带上服务地址，方便模型解释连不上时该查哪儿', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  try {
    assert.ok(registry.get('x_timeline').description.includes(fake.baseUrl));
  } finally {
    await fake.close();
  }
});

test('x_drafts：列出待审草稿并带上目标账号', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  try {
    const value = await registry.get('x_drafts').execute({}, {});
    assert.equal(value.pending, 1);
    assert.equal(value.items[0].kind, 'reply');
    assert.equal(value.items[0].targetHandle, 'sama');
    assert.match(value.items[0].createdAt, /T/);
  } finally {
    await fake.close();
  }
});

test('x_review：approve 返回 sent 和推文 id', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  try {
    const value = await registry.get('x_review').execute({ id: 'd1', action: 'approve' }, {});
    assert.equal(value.status, 'sent');
    assert.equal(value.resultId, '555');
  } finally {
    await fake.close();
  }
});

test('x_review：非法 action 直接拒绝，不会误发', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  try {
    await assert.rejects(
      () => registry.get('x_review').execute({ id: 'd1', action: 'boom' }, {}),
      /approve 或 reject/,
    );
  } finally {
    await fake.close();
  }
});

test('手写的 JSON Schema 必须落在宿主接受的子集里（用宿主自己的校验器验）', async () => {
  const fake = await startFakeService();
  const { registry } = await mountPlugin({ baseUrl: fake.baseUrl, token: 't' });
  try {
    for (const def of registry.values()) {
      assert.doesNotThrow(() => assertSupportedJsonSchema(def.parameters), `${def.name}.parameters`);
      assert.doesNotThrow(() => assertSupportedJsonSchema(def.output.schema), `${def.name}.output.schema`);
      assert.equal(typeof def.output.render, 'function');
    }
  } finally {
    await fake.close();
  }
});
