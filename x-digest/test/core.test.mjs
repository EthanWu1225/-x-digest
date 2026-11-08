import test from 'node:test';
import assert from 'node:assert/strict';
import { oauth1Header, signOAuth, signatureBaseString } from '../src/oauth1.mjs';
import { compose, weightedLength } from '../src/compose.mjs';
import { pruneState, markSeen, newCandidates, emptyState } from '../src/state.mjs';

// X 官方文档里那个经典示例（把 body 参数当作 query 传入，验证 base string 与 HMAC 是否正确）
test('OAuth1 签名与 Twitter 官方示例一致', () => {
  const credentials = {
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    accessTokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  };

  // 官方示例里还带了 include_entities=true，漏掉它签出来的值就不一样
  const query = { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true' };

  const signed = signOAuth(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json',
    credentials,
    query,
    { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: '1318622958' },
  );

  assert.equal(signed.oauth_signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');

  const base = signatureBaseString('POST', 'https://api.twitter.com/1.1/statuses/update.json', {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  });
  assert.ok(base.startsWith('POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&'));
});

test('OAuth1 头包含全部必需字段', () => {
  const header = oauth1Header('POST', 'https://api.x.com/2/tweets', {
    consumerKey: 'ck',
    consumerSecret: 'cs',
    accessToken: 'at',
    accessTokenSecret: 'ats',
  });
  assert.match(header, /^OAuth /);
  for (const key of [
    'oauth_consumer_key',
    'oauth_nonce',
    'oauth_signature',
    'oauth_signature_method',
    'oauth_timestamp',
    'oauth_token',
    'oauth_version',
  ]) {
    assert.ok(header.includes(`${key}="`), `缺少 ${key}`);
  }
});

test('weightedLength：链接算 23，CJK 算 2', () => {
  assert.equal(weightedLength('abc'), 3);
  assert.equal(weightedLength('你好'), 4);
  assert.equal(weightedLength('https://x.com/a/status/1'), 23);
  assert.equal(weightedLength('看 https://x.com/a/status/1'), 2 + 1 + 23);
});

test('compose：永不超长，且总是 @ 目标', () => {
  const picks = Array.from({ length: 3 }, (_, i) => ({
    id: String(i),
    handle: 'someone',
    url: 'https://x.com/someone/status/1234567890',
    reason: '这是一条非常长的理由，用来测试截断逻辑是否真的会生效并且不会把整条推文撑爆',
    text: 'x',
  }));
  const { text, dropped } = compose(picks, 'me', { maxLength: 275 });
  assert.ok(weightedLength(text) <= 275, `超长了：${weightedLength(text)}`);
  assert.ok(text.startsWith('@me '));
  assert.equal(picks.length - dropped >= 1, true);
});

test('compose：单条也超长时退化到只给链接', () => {
  const { text } = compose(
    [{ handle: 'a', url: 'https://x.com/a/status/1', reason: '很长'.repeat(60) }],
    'me',
    { maxLength: 120 },
  );
  assert.ok(weightedLength(text) <= 120);
  assert.ok(text.includes('https://x.com/a/status/1'));
});

test('state：去重与过期清理', () => {
  const items = [{ id: '1' }, { id: '2' }];
  const state = emptyState();
  assert.deepEqual(newCandidates(items, state.seen).map((i) => i.id), ['1', '2']);
  markSeen(state, [items[0]]);
  assert.deepEqual(newCandidates(items, state.seen).map((i) => i.id), ['2']);

  state.posts = [{ ts: Date.now(), id: 'old' }, { ts: Date.now() - 30 * 86400_000, id: 'ancient' }];
  state.seen.stale = Date.now() - 30 * 86400_000;
  pruneState(state);
  assert.equal(state.posts.length, 1);
  assert.equal(state.seen.stale, undefined);
});
