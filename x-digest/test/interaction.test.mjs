import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { XSession, XSessionError } = await import('../src/xsession.mjs');
const { emptyQueue, addDraft, listDrafts, approveDraft, rejectDraft, sentToday } = await import('../src/drafts.mjs');

/** 造一个 GraphQL 结构的 tweet 节点。 */
function tweetNode(id, text, { retweet = false, reply = false, handle = 'sama' } = {}) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: { legacy: { screen_name: handle } } } },
    legacy: {
      id_str: id,
      full_text: retweet ? `RT @someone: ${text}` : text,
      created_at: 'Sun Nov 01 10:00:00 +0000 2026',
      favorite_count: 3,
      retweet_count: 1,
      reply_count: 0,
      in_reply_to_status_id_str: reply ? '100' : undefined,
      entities: { media: [] },
    },
  };
}

function timelinePayload(nodes) {
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                { type: 'TimelineClearCache' },
                {
                  type: 'TimelineAddEntries',
                  entries: nodes.map((node, i) => ({
                    entryId: `tweet-${i}`,
                    content: { itemContent: { tweet_results: { result: node } } },
                  })),
                },
              ],
            },
          },
        },
      },
    },
  };
}

/** 假的 x.com / api.x.com：按路径后缀分派。 */
async function fakeX({ failStatus, failBody } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });

      if (failStatus) {
        res.writeHead(failStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(failBody ?? { errors: [{ code: 32 }] }));
      }

      const send = (o) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };

      if (url.pathname === '/1.1/dm/inbox_initial_state.json') {
        return send({ inbox_initial_state: { users: { 42: { screen_name: 'bot' } } } });
      }
      if (url.pathname === '/1.1/dm/new2.json') {
        return send({ id: '777' });
      }
      if (url.pathname.endsWith('/UserByScreenName')) {
        return send({ data: { user: { result: { rest_id: '1605', legacy: { name: 'Sam Altman' } } } } });
      }
      if (url.pathname.endsWith('/UserTweets')) {
        return send(
          timelinePayload([
            tweetNode('900', '正常推文一'),
            tweetNode('901', '这是转推', { retweet: true }),
            tweetNode('902', '这是回复', { reply: true }),
            tweetNode('903', '正常推文二'),
          ]),
        );
      }
      if (url.pathname.endsWith('/TweetDetail')) {
        return send(
          timelinePayload([tweetNode('900', '主推文'), tweetNode('904', '第一条回复'), tweetNode('905', '第二条回复')]),
        );
      }
      if (url.pathname.endsWith('/CreateTweet')) {
        const payload = JSON.parse(body);
        return send({
          data: {
            create_tweet: {
              tweet_results: {
                result: { rest_id: '555', legacy: { full_text: payload.variables.tweet_text } },
              },
            },
          },
        });
      }
      return send({});
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

function newSession(base) {
  return new XSession({ authToken: 'tok', ct0: 'csrf', baseUrl: base, webBase: base, timeoutMs: 8000 });
}

test('鉴权探针：DM 收件箱能读就说明 cookie 有效', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    const r = await s.checkAuth();
    assert.equal(r.ok, true);
    const h = x.calls[0].headers;
    assert.equal(h['x-csrf-token'], 'csrf');
    assert.match(h.cookie, /auth_token=tok/);
  } finally {
    await x.close();
  }
});

test('查用户 id（GraphQL UserByScreenName）', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    const user = await s.lookupUserId('@sama');
    assert.equal(user.id, '1605');
    assert.equal(user.handle, 'sama');
    assert.ok(x.calls[0].path.endsWith('/UserByScreenName'));
  } finally {
    await x.close();
  }
});

test('读时间线：过滤转推和回复', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    const items = await s.userTimeline('sama', { count: 10 });
    assert.equal(items.length, 2, '4 条里应该只剩 2 条原创');
    assert.deepEqual(items.map((i) => i.id).sort(), ['900', '903']);
    assert.equal(items[0].handle, 'sama');
    assert.ok(items[0].createdAt > 0);
  } finally {
    await x.close();
  }
});

test('读会话：主推 + 回复分开', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    const conv = await s.conversation('900');
    assert.equal(conv.root.id, '900');
    assert.equal(conv.replies.length, 2);
  } finally {
    await x.close();
  }
});

test('发回复：走 CreateTweet，带 tweet_text 与 in_reply_to_tweet_id', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    const r = await s.post('回你一句', { replyTo: '900' });
    assert.equal(r.id, '555');

    const call = x.calls.find((c) => c.path.endsWith('/CreateTweet'));
    const payload = JSON.parse(call.body);
    assert.equal(payload.variables.tweet_text, '回你一句');
    assert.equal(payload.variables.reply.in_reply_to_tweet_id, '900');
    assert.ok(payload.features, '必须带 features 开关');
  } finally {
    await x.close();
  }
});

test('发推拒绝超长内容', async () => {
  const s = new XSession({ authToken: 't', ct0: 'c', baseUrl: 'http://127.0.0.1:9', webBase: 'http://127.0.0.1:9' });
  await assert.rejects(() => s.post('长'.repeat(281)), /超过 280/);
});

test('发私信：仍走 v1.1 dm/new2', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    await s.dm('42', '你好');
    const call = x.calls.find((c) => c.path === '/1.1/dm/new2.json');
    assert.equal(call.query.recipient_ids, '42');
    assert.equal(call.query.text, '你好');
  } finally {
    await x.close();
  }
});

test('401 会被翻译成人话', async () => {
  const x = await fakeX({ failStatus: 401 });
  try {
    const s = newSession(x.base);
    await assert.rejects(
      () => s.checkAuth(),
      (err) => err instanceof XSessionError && /cookie 失效/.test(err.message),
    );
  } finally {
    await x.close();
  }
});

test('审核队列：草稿 → 通过 → 发出', async () => {
  const x = await fakeX();
  try {
    const s = newSession(x.base);
    const queue = emptyQueue();
    const item = addDraft(queue, { kind: 'reply', text: '这条值得回', target: { id: '900', handle: 'sama' } });
    assert.equal(listDrafts(queue, { status: 'pending' }).length, 1);

    await approveDraft(queue, item.id, s, { timeZone: 'Asia/Shanghai', replyDailyLimit: 5, dmDailyLimit: 3 });
    assert.equal(item.status, 'sent');
    assert.equal(item.resultId, '555');
    assert.equal(sentToday(queue, 'reply', 'Asia/Shanghai'), 1);
  } finally {
    await x.close();
  }
});

test('审核队列：驳回后不能发', async () => {
  const queue = emptyQueue();
  const item = addDraft(queue, { kind: 'tweet', text: '随便发一条' });
  rejectDraft(queue, item.id, '不想发');
  assert.equal(item.status, 'rejected');
  await assert.rejects(
    () => approveDraft(queue, item.id, { post: async () => ({}) }, { timeZone: 'UTC' }),
    /不能发送/,
  );
});

test('审核队列：超过每日上限就拒绝', async () => {
  const queue = emptyQueue();
  const s = { post: async () => ({ id: '1' }) };
  const limits = { timeZone: 'Asia/Shanghai', replyDailyLimit: 1, dmDailyLimit: 3 };

  const first = addDraft(queue, { kind: 'reply', text: 'a', target: { id: '1' } });
  await approveDraft(queue, first.id, s, limits);

  const second = addDraft(queue, { kind: 'reply', text: 'b', target: { id: '2' } });
  await assert.rejects(() => approveDraft(queue, second.id, s, limits), /上限/);
});

test('审核队列：发送失败时草稿标记 failed 并保留错误', async () => {
  const queue = emptyQueue();
  const item = addDraft(queue, { kind: 'dm', text: 'hi', target: { id: '42' } });
  const broken = {
    dm: async () => {
      throw new Error('被限流');
    },
  };
  await assert.rejects(
    () => approveDraft(queue, item.id, broken, { timeZone: 'UTC', dmDailyLimit: 3 }),
    /被限流/,
  );
  assert.equal(item.status, 'failed');
  assert.match(item.error, /被限流/);
});

test('cookie 会话可以直接当数据源：按 WATCH_HANDLES 读并归一化', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { fetchSessionTimeline } = await import('../src/sources.mjs');

  const x = await fakeX();
  const prevApi = process.env.X_API_BASE;
  const prevWeb = process.env.X_WEB_BASE;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdigest-'));
    const cookiesFile = path.join(dir, 'cookies.json');
    writeFileSync(cookiesFile, JSON.stringify({ auth_token: 'tok', ct0: 'csrf' }));
    process.env.X_API_BASE = x.base;
    process.env.X_WEB_BASE = x.base;

    const feed = await fetchSessionTimeline({ handles: ['sama'], limitPerHandle: 10, session: { cookiesFile, timeoutMs: 8000 } });
    assert.equal(feed.source, 'session');
    assert.equal(feed.items.length, 2);
    assert.ok(feed.items.every((i) => i.createdAt > 0 && i.handle === 'sama'));
  } finally {
    if (prevApi === undefined) delete process.env.X_API_BASE;
    else process.env.X_API_BASE = prevApi;
    if (prevWeb === undefined) delete process.env.X_WEB_BASE;
    else process.env.X_WEB_BASE = prevWeb;
    await x.close();
  }
});
