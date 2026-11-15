/**
 * 浏览器自动化发回复（不花 API 额度）。
 *
 * 原理：用你机器上已装的 Edge，开一个**独立 profile**（不影响你日常浏览器），
 * 以真实网页身份打开目标推文 → 填回复 → 点发送。
 *
 * 首次需要你在这个窗口里登录一次小号；之后 profile 会记住登录态，全自动。
 */

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const LINUX_BROWSERS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

/**
 * 按平台挑浏览器：
 *   · 显式设了 BROWSER_EXECUTABLE 就用它（VPS / Docker 推荐）
 *   · Windows 用本机 Edge
 *   · Linux 找系统 chromium/chrome
 */
function launchTarget() {
  const explicit = process.env.BROWSER_EXECUTABLE;
  if (explicit && existsSync(explicit)) return { executablePath: explicit };
  if (explicit) return { executablePath: explicit };

  if (process.platform === 'win32') {
    const edge = EDGE_PATHS.find((p) => existsSync(p));
    return edge ? { executablePath: edge } : { channel: 'msedge' };
  }

  const found = LINUX_BROWSERS.find((p) => existsSync(p));
  return found ? { executablePath: found } : { channel: 'chromium' };
}

export class BrowserError extends Error {}

/**
 * 打开（或复用）一个独立的浏览器上下文。
 * @param {{ dataDir: string, headless?: boolean, channel?: string }} opts
 */
export async function launchContext({ dataDir, headless = true }) {
  const userDataDir = path.join(dataDir, 'browser-profile');
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'];

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      ...launchTarget(),
      args,
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      timezoneId: process.env.TZ || 'Asia/Shanghai',
    });
    return context;
  } catch (err) {
    throw new BrowserError(
      `启动浏览器失败：${err.message}。如果提示找不到 Edge，把 EDGE_PATHS 里的路径改成你的安装位置`,
    );
  }
}

/**
 * 只读地检查当前页面是否已登录 —— **不导航、不刷新**。
 * （登录过程中每几秒刷新一次会把用户正在输的账号刷掉。）
 */
export async function loginState(context) {
  const pages = context.pages();
  if (!pages.length) return { ok: false, reason: '没有打开的页面' };
  // 优先看当前活动页（用户可能开着多个标签）
  let page = pages[pages.length - 1];
  try {
    const url = page.url();
    if (/\/i\/flow\/login|\/login/.test(url)) return { ok: false, reason: '还在登录页' };

    // 用很短超时探测登录后才会出现的元素，不触发任何导航
    const hit = await page
      .locator('[data-testid="SideNav_NewTweet_Button"], [data-testid="tweetTextarea_0"]')
      .first()
      .waitFor({ state: 'attached', timeout: 800 })
      .then(() => true)
      .catch(() => false);

    return hit ? { ok: true, reason: '' } : { ok: false, reason: '还没看到发帖入口' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** 当前 profile 是否已登录（会导航一次，适合一次性检查）。 */
export async function isLoggedIn(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    const url = page.url();
    if (/\/login|\/i\/flow\/login/.test(url)) return { ok: false, reason: '被重定向到登录页' };

    const composer = await page.locator('[data-testid="tweetTextarea_0"]').count();
    if (composer > 0) return { ok: true, reason: '' };

    // 有些情况下 composer 需要点一下才出现
    const side = await page.locator('[data-testid="SideNav_NewTweet_Button"]').count();
    if (side > 0) return { ok: true, reason: '' };

    return { ok: false, reason: `没找到发帖框（当前地址 ${url}）` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 无状态浏览器：不落盘、不用 profile，直接把小号的 cookie 注入进去。
 *
 * 为什么不用 launchPersistentContext：
 *   那个 125MB 的 profile 在 Windows 上启动很不稳定（实测 38s 到 180s 超时都有），
 *   而且不能并发。发回复只需要"已登录"，cookie( auth_token + ct0 ) 就够了。
 */
export async function launchStateless(cfg) {
  const { readFileSync } = await import('node:fs');
  let cookies = {};
  try {
    cookies = JSON.parse(readFileSync(cfg.session.cookiesFile, 'utf8'));
  } catch {
    /* 没有就按未登录跑，页面会提示 */
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: cfg.browserHeadless !== false,
      ...launchTarget(),
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    throw new BrowserError(`启动浏览器失败：${err.message}`);
  }

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  if (cookies.auth_token && cookies.ct0) {
    await context.addCookies([
      { name: 'auth_token', value: cookies.auth_token, domain: '.x.com', path: '/', httpOnly: true, secure: true },
      { name: 'ct0', value: cookies.ct0, domain: '.x.com', path: '/', secure: true },
      { name: 'auth_token', value: cookies.auth_token, domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
      { name: 'ct0', value: cookies.ct0, domain: '.twitter.com', path: '/', secure: true },
    ]);
  }

  context.__browser = browser; // 关的时候一起关
  return context;
}

/** 发回复前先确认 x.com 能连上：连不上就立刻报错，别让浏览器干等到超时。 */
async function ensureReachable() {
  try {
    const res = await fetch('https://x.com/robots.txt', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; x-digest/0.1)' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new BrowserError(`连不上 x.com（${err.message}）——先检查代理是否开着`);
  }
}

/**
 * 复用同一个浏览器上下文（省掉每条回复都重启浏览器的十几秒）。
 * 空闲 10 分钟后自动关闭，不长期占内存。
 */
let sharedCtx = null;
let idleTimer = null;

export async function withContext(cfg, fn) {
  await ensureReachable();
  if (!sharedCtx) {
    sharedCtx = await launchStateless(cfg);
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const dying = sharedCtx;
    sharedCtx = null;
    closeContext(dying);
  }, 600_000); // 保活 10 分钟：@ 每 5 分钟一轮，别每轮都冷启动
  idleTimer.unref?.();

  try {
    return await fn(sharedCtx);
  } catch (err) {
    const dying = sharedCtx;
    sharedCtx = null;
    await closeContext(dying);
    throw err;
  }
}

export async function shutdownSharedContext() {
  const dying = sharedCtx;
  sharedCtx = null;
  if (idleTimer) clearTimeout(idleTimer);
  await closeContext(dying);
}

/**
 * 在指定推文下回复。
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} tweetUrl
 * @param {string} text
 * @param {{ dry?: boolean, fast?: boolean }} opts
 *        fast=true 时屏蔽图片/视频/字体请求、缩小等待，用于"只需要发出文字"的场合
 */
export async function replyToTweet(context, tweetUrl, text, { dry = false, fast = false } = {}) {
  const page = await context.newPage();

  if (fast) {
    // 回复只关心发帖框，不需要图片/视频/字体 —— 这一步能把页面加载砍掉一半以上
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
  }

  try {
    const t0 = Date.now();
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const box = page.locator('[data-testid="tweetTextarea_0"]').first();
    try {
      // 无状态上下文没有缓存，首次打开 SPA 要 20–40 秒；等发帖框出现比等网络空闲靠谱
      await box.waitFor({ state: 'visible', timeout: fast ? 45000 : 60000 });
    } catch {
      throw new BrowserError(
        `打开发帖框失败（${page.url()}）。可能是没登录、推文不存在，或页面结构变了`,
      );
    }

    await box.click();
    // 逐字输入（太快会被识别成粘贴），fast 模式下加快
    await page.keyboard.type(text, { delay: fast ? 8 : 25 });
    await page.waitForTimeout(fast ? 400 : 800);

    if (dry) {
      const shot = path.join(os.tmpdir(), `x-reply-dry-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      return { dry: true, screenshot: shot, url: page.url() };
    }

    const button = page.locator('[data-testid="tweetButtonInline"]').first();
    if (!(await button.count())) throw new BrowserError('没找到「回复」按钮（页面结构可能变了）');

    // 按钮未启用时等一会儿
    for (let i = 0; i < 20; i += 1) {
      if ((await button.getAttribute('aria-disabled')) !== 'true') break;
      await page.waitForTimeout(250);
    }

    await button.click();
    await page.waitForTimeout(fast ? 2500 : 4000);

    let screenshot = '';
    if (!fast) {
      screenshot = path.join(os.tmpdir(), `x-reply-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
    }

    return { ok: true, screenshot, url: page.url(), ms: Date.now() - t0 };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeContext(context) {
  if (!context) return;
  try {
    await context.close();
  } catch {
    /* ignore */
  }
  try {
    await context.__browser?.close();
  } catch {
    /* ignore */
  }
}




