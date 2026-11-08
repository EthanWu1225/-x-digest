#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { loadConfig, loadDotenv, validateForRun, ConfigError } from './config.mjs';
import { createLogger } from './logger.mjs';
import { fetchTimeline } from './sources.mjs';
import { runCycle, readInterests } from './digest.mjs';
import { whoami } from './xpost.mjs';
import { startServer } from './server.mjs';
import { loadSessionFromFile } from './xsession.mjs';
import { launchContext, isLoggedIn, loginState, replyToTweet, closeContext } from './browser.mjs';
import { createPkcePair, buildAuthorizeUrl, exchangeCode } from './oauth2.mjs';
import { savePending, loadPending } from './oauth-auth.mjs';
import { randomBytes } from 'node:crypto';
import { saveTokens, tokensFile, hasTokens } from './tokens.mjs';

const args = new Set(process.argv.slice(2));
const has = (...names) => names.some((n) => args.has(n));

// npm run auth:finish -- <verifier>  或者  --auth-finish=<verifier>
const argv = process.argv.slice(2);
const finishIdx = argv.findIndex((a) => a === '--auth-finish' || a.startsWith('--auth-finish='));
const authFinishVerifier =
  finishIdx < 0
    ? null
    : argv[finishIdx].includes('=')
      ? (argv[finishIdx].split('=')[1] ?? '')
      : (argv[finishIdx + 1] ?? '');

function line(s = '') {
  console.log(s);
}

async function probe(cfg, logger) {
  line(`配置：${cfg.handles.length} 个账号 | POST_MODE=${cfg.postMode} | TZ=${cfg.timeZone}`);
  line(`抓取上限：每账号 ${cfg.limitPerHandle} 条 | 每次最多挑 ${cfg.maxPicks} 条`);
  line('');

  let ok = 0;
  for (const handle of cfg.handles) {
    const res = await fetchTimeline(handle, cfg);
    if (res.error) {
      line(`✗ @${handle.padEnd(18)} ${res.error}`);
      continue;
    }
    ok += 1;
    line(`✓ @${handle.padEnd(18)} ${String(res.items.length).padStart(2)} 条（来源 ${res.source}）`);
    const top = res.items[0];
    if (top) {
      const age = Math.round((Date.now() - top.createdAt) / 3600_000);
      line(`   最新 ${age} 小时前：${top.text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  line('');

  if (cfg.deepseek.apiKey) {
    try {
      const res = await fetch(`${cfg.deepseek.baseUrl}/models`, {
        headers: { authorization: `Bearer ${cfg.deepseek.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const models = (data?.data ?? []).map((m) => m.id).join(', ');
        line(`✓ DeepSeek key 可用（模型：${models || '未返回'}）`);
      } else {
        line(`✗ DeepSeek key 被拒：HTTP ${res.status}`);
      }
    } catch (err) {
      line(`✗ DeepSeek 连通性失败：${err.message}`);
    }
  } else {
    line('· 没填 DEEPSEEK_API_KEY，跳过大模型检查');
  }

  if (cfg.canPost) {
    try {
      const me = await whoami(cfg);
      line(`✓ X 发推凭据可用，机器人账号 @${me?.username ?? '?'}${me?.name ? `（${me.name}）` : ''}`);
    } catch (err) {
      line(`✗ X 发推凭据不可用：${err.message}`);
    }
  } else {
    line('· 没填 X_CONSUMER_* / X_ACCESS_TOKEN*，发推功能不可用（POST_MODE 也只能是 off）');
  }

  line('');
  line(ok ? `探测完成：${ok}/${cfg.handles.length} 个账号可用。下一步：npm run once` : '探测全失败：这台机器出不去网，或来源改了。');
  return ok > 0 ? 0 : 1;
}

async function main() {
  loadDotenv('.env');

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`配置错误：${err.message}`);
      return 2;
    }
    throw err;
  }

  const logger = createLogger({ file: cfg.paths.log, debug: cfg.debug || has('--verbose') });

  if (has('--probe')) return probe(cfg, logger);

  if (has('--whoami')) {
    if (!cfg.canPost) {
      console.error('缺少 X_CONSUMER_* / X_ACCESS_TOKEN*，无法验证发推身份');
      return 2;
    }
    const me = await whoami(cfg);
    console.log(JSON.stringify(me, null, 2));
    return 0;
  }

  if (has('--auth-start')) {
    if (!cfg.oauth2.clientId || !cfg.oauth2.clientSecret) {
      line('✗ 还需要 X_CLIENT_ID / X_CLIENT_SECRET（开发者 App 的 OAuth 2.0 Client ID / Secret）');
      return 2;
    }
    const { verifier, challenge } = createPkcePair();
    const state = randomBytes(8).toString('hex');
    const url = buildAuthorizeUrl({
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

    line(`回调地址：${cfg.oauth2.redirectUri}`);
    line('');
    line('1) 用【小号】登录浏览器，打开这个链接并点 Authorize app：');
    line('');
    line(`   ${url}`);
    line('');
    line('2) 授权后会跳到形如 https://example.com/?state=...&code=XXXX 的地址（页面打不开是正常的）');
    line('   把 code= 后面那一整串复制下来（到 & 为止），运行：');
    line('');
    line('   npm run auth:finish -- <code>');
    return 0;
  }

  if (authFinishVerifier !== null) {
    if (!authFinishVerifier) {
      line('✗ 用法：npm run auth:finish -- <code>');
      return 2;
    }
    const pending = loadPending(path.join(cfg.dataDir, 'oauth-pending.json'));
    if (!pending?.verifier) {
      line('✗ 没找到待授权的 PKCE 记录，先运行 npm run auth:start');
      return 2;
    }

    const tokens = await exchangeCode({
      clientId: cfg.oauth2.clientId,
      clientSecret: cfg.oauth2.clientSecret,
      code: authFinishVerifier,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier,
    });

    // 用新 token 认一下身份，顺便验证权限是否够
    const probeCfg = { ...cfg, oauth2: { ...cfg.oauth2, ...tokens } };
    const me = await whoami(probeCfg).catch((err) => {
      line(`⚠ token 已拿到，但 /2/users/me 失败：${err.message}`);
      return null;
    });

    saveTokens(tokensFile(cfg.dataDir), { ...tokens, screenName: me?.username ?? '', obtainedAt: Date.now() });
    line(`✓ 授权成功：@${me?.username ?? '(未知)'}（id ${me?.id ?? '?'}）`);
    line(`  token 已存到 ${tokensFile(cfg.dataDir)}`);
    line(`  过期时间：${new Date(tokens.expiresAt).toISOString()}（会自动续期）`);
    line('');
    line('之后发推就用这个账号的身份。运行 npm run whoami 确认。');
    return 0;
  }

  if (has('--browser-login')) {
    line('正在打开浏览器（独立 profile，不影响你日常用的浏览器）…');
    const context = await launchContext({ dataDir: cfg.dataDir, headless: false });

    // 只导航这一次；之后只读页面状态，绝不刷新（否则会打断你输入账号）
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    line('请在打开的窗口里用【小号 @jia88586】登录 x.com。');
    line('（不会刷新页面；需要短信/邮箱验证码就正常填，最多等 20 分钟）');
    line('');

    let ok = false;
    for (let i = 0; i < 400; i += 1) {
      const state = await loginState(context);
      if (state.ok) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    await closeContext(context);

    if (ok) {
      line('✓ 登录态已保存到浏览器 profile，之后可以全自动发回复。');
      return 0;
    }
    line('✗ 20 分钟内没检测到登录。重新运行 npm run browser:login 再试一次。');
    return 1;
  }

  if (has('--session-probe')) {
    line(`cookie 文件：${cfg.session.cookiesFile}`);
    let session;
    try {
      session = loadSessionFromFile(cfg);
    } catch (err) {
      line(`✗ ${err.message}`);
      return 2;
    }

    const target = cfg.handles[0];
    const result = await session.probe({ handle: target });

    if (!result.auth?.ok) {
      line(`✗ 鉴权失败：${result.auth?.error ?? '未知'}`);
      line('');
      line('多半是 auth_token / ct0 过期，或者小号在新设备登录被要求验证。重新导一次 cookie。');
      return 1;
    }
    line('✓ 鉴权通过（DM 接口可用，说明 cookie 是登录态）');

    if (result.read?.ok) {
      line(`✓ 读时间线 @${result.read.handle}：${result.read.count} 条`);
    } else {
      line(`✗ 读时间线：${result.read?.error ?? '未知'}`);
    }
    line(
      result.detail?.ok
        ? `✓ 读推文会话：${result.detail.replies} 条回复`
        : `· 读推文会话：${result.detail?.error ?? '未测试'}`,
    );
    line('');
    line('探针只读，没有发出任何内容。写操作（回复/私信）只能走审核队列，人工点「发」。');
    return result.read?.ok ? 0 : 1;
  }

  const problems = validateForRun(cfg);
  if (problems.length) {
    console.error('还不能跑：\n- ' + problems.join('\n- '));
    return 2;
  }

  if (has('--serve')) {
    const { close } = startServer(cfg, logger);
    logger.info('服务已启动（Ctrl+C 退出）');
    const shutdown = async () => {
      logger.info('正在关闭…');
      await close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
    return 0;
  }

  const dry = has('--dry') || cfg.postMode === 'off';
  line('');
  line('── 兴趣画像 ──────────────────────────────');
  const interests = readInterests(cfg).trim();
  line(interests ? interests.split('\n').slice(0, 6).join('\n') : '（interests.md 为空，按通用高价值标准判断）');
  line('──────────────────────────────────────────');
  line('');

  const result = await runCycle(cfg, { dry, force: has('--force'), logger });

  line('');
  line('── 本轮结果 ──────────────────────────────');
  line(`抓取 ${result.fetched} 条 / 新 ${result.candidates} 条 / 挑中 ${result.picks.length} 条`);
  if (result.skipped) line(`跳过原因：${result.skipped}`);
  if (result.posted) line(`已发：https://x.com/i/status/${result.posted.id}`);
  if (result.errors.length) line(`错误：\n- ${result.errors.join('\n- ')}`);
  return result.errors.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
