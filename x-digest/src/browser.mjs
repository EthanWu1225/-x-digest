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
 * 在指定推文下回复。
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} tweetUrl
 * @param {string} text
 * @param {{ dry?: boolean }} opts dry=true 时只填不点发送
 */
export async function replyToTweet(context, tweetUrl, text, { dry = false, fast = false } = {}) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(fast ? 1800 : 3500);

  const box = page.locator('[data-testid="tweetTextarea_0"]').first();
  try {
    await box.waitFor({ state: 'visible', timeout: 30000 });
  } catch {
    throw new BrowserError(
      `打开发帖框失败（${page.url()}）。可能是没登录、推文不存在，或页面结构变了`,
    );
  }

  await box.click();
  await page.waitForTimeout(400);
  // 逐字输入，避免被识别成粘贴
  await page.keyboard.type(text, { delay: 25 });
  await page.waitForTimeout(800);

  if (dry) {
    const shot = path.join(os.tmpdir(), `x-reply-dry-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    return { dry: true, screenshot: shot, url: page.url() };
  }

  const button = page.locator('[data-testid="tweetButtonInline"]').first();
  const visible = await button.count();
  if (!visible) throw new BrowserError('没找到「回复」按钮（页面结构可能变了）');

  // 按钮未启用时等一会儿
  for (let i = 0; i < 20; i += 1) {
    const disabled = await button.getAttribute('aria-disabled');
    if (disabled !== 'true') break;
    await page.waitForTimeout(300);
  }

  await button.click();
  await page.waitForTimeout(4000);

  const shot = path.join(os.tmpdir(), `x-reply-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  return { ok: true, screenshot: shot, url: page.url() };
}

export async function closeContext(context) {
  try {
    await context.close();
  } catch {
    /* ignore */
  }
}

