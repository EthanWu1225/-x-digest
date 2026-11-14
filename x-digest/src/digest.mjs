import { existsSync, readFileSync } from 'node:fs';
import { fetchAll, fetchSessionTimeline, fetchSearchTimeline, fetchHomeTimeline } from './sources.mjs';
import { judge } from './judge.mjs';
import { compose } from './compose.mjs';
import { loadState, saveState, pruneState, markSeen, newCandidates } from './state.mjs';
import { latestTweet, latestTweetId, postTweet } from './xpost.mjs';
import { loadSessionFromFile } from './xsession.mjs';
import { launchContext, replyToTweet, closeContext } from './browser.mjs';
import { checkSensitive, safeRule } from './safety.mjs';
import { recordHistory } from './history.mjs';
import { describeImage, describeVideo, visionReady } from './vision.mjs';

/**
 * 给「带图的候选推文」看图，把描述挂到 item.imageDesc 上。
 * 只挑赞数最高的几张，控制时间和成本（每次最多 cfg.visionMaxImages 张）。
 */
async function enrichImages(cfg, candidates, log) {
  if (!cfg.visionInDigest || !visionReady(cfg)) return;

  const targets = candidates
    .filter((c) => c.images?.length)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, cfg.visionMaxImages);

  if (!targets.length) return;
  log.info(`给 ${targets.length} 条带图推文看图…`);

  // 三张一组并发，避免一条卡住整轮
  for (let i = 0; i < targets.length; i += 3) {
    await Promise.allSettled(
      targets.slice(i, i + 3).map(async (c) => {
        c.imageDesc = await describeImage(c.images[0], cfg);
      }),
    );
  }

  const ok = targets.filter((t) => t.imageDesc).length;
  log.info(`看图完成 ${ok}/${targets.length}`);

  // 视频：抽帧成本高（下载 + 抽帧 + 多图），每轮只处理赞数最高的几条
  if (!cfg.visionVideo) return;
  const videos = candidates
    .filter((c) => c.videoUrl && !c.videoDesc)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, cfg.visionMaxVideos);

  for (const c of videos) {
    try {
      log.info(`识别视频 @${c.handle}…`);
      c.videoDesc = await describeVideo(c.videoUrl, cfg, { maxFrames: cfg.visionVideoFrames });
      log.info(`视频完成 @${c.handle}：${c.videoDesc.slice(0, 40)}…`);
    } catch (err) {
      log.warn(`视频识别失败 @${c.handle}：${err.message.slice(0, 80)}`);
    }
  }
}

/** 把挑中的推文记进「刷过的推文」（干跑/发送/失败都要留痕）。 */
function rememberPicks(cfg, picks, action, detail = '') {
  for (const p of picks) {
    recordHistory(cfg, {
      id: p.id,
      handle: p.handle,
      text: p.text,
      url: p.url,
      reason: p.reason,
      action,
      detail,
    });
  }
}

/** 有 cookie 就用会话（读+写都走它），没有就返回 null 走旧路径。 */
function tryLoadSession(cfg) {
  try {
    return loadSessionFromFile(cfg);
  } catch {
    return null;
  }
}

export function readInterests(cfg) {
  try {
    return existsSync(cfg.interestsFile) ? readFileSync(cfg.interestsFile, 'utf8') : '';
  } catch {
    return '';
  }
}

function localNow(cfg, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 免打扰时段：返回 true 表示此刻不该发。 */
export function inQuietHours(cfg, now = new Date()) {
  const start = parseHm(cfg.quietStart);
  const end = parseHm(cfg.quietEnd);
  if (start === null || end === null || start === end) return false;
  const { minutes } = localNow(cfg, now);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function postsToday(state, cfg, now = new Date()) {
  const { dateKey } = localNow(cfg, now);
  return (state.posts ?? []).filter((p) => localNow(cfg, new Date(p.ts)).dateKey === dateKey).length;
}

/**
 * 跑一轮：抓 → 去重 → 让 DeepSeek 挑 → 拼文案 → （或）发出去。
 * dry = true 时只打印，不碰 X 的写接口。
 */
export async function runCycle(cfg, { dry = false, logger = console, force = false } = {}) {
  const log = logger.info ? logger : { info: console.log, warn: console.warn, error: console.error, debug() {} };
  const state = loadState(cfg.paths.state);
  const startedAt = Date.now();
  const result = {
    startedAt,
    fetched: 0,
    candidates: 0,
    picks: [],
    text: null,
    posted: null,
    skipped: null,
    errors: [],
  };

  // 优先用 cookie 会话读关注时间线（登录态才有的权限）；
  // 没有 cookie 或会话失效时，退回匿名来源（多半会被 429，但至少给出明确原因）。
  let all = [];
  try {
    const sessionFeed =
      cfg.source === 'search'
        ? await fetchSearchTimeline(cfg, { count: cfg.maxCandidates })
        : cfg.source === 'home'
          ? await fetchHomeTimeline(cfg, { count: cfg.maxCandidates })
          : await fetchSessionTimeline(cfg, { count: cfg.maxCandidates });
    all = sessionFeed.items;
    result.fetched = all.length;
    result.source = sessionFeed.source;
    log.info(
      `${sessionFeed.source === 'search' ? '按关键词搜索到' : sessionFeed.source === 'home' ? '首页推荐流读到' : '用 cookie 会话读到'} ${all.length} 条推文`,
    );
    if (sessionFeed.errors?.length) result.errors.push(...sessionFeed.errors);
  } catch (sessionErr) {
    log.debug(`会话来源不可用：${sessionErr.message}，退回匿名来源`);
    result.errors.push(`session: ${sessionErr.message}`);

    const fetched = await fetchAll(cfg.handles, cfg, {
      onItem: (handle, r) => {
        if (r.error) {
          result.errors.push(`${handle}: ${r.error}`);
          log.warn(`抓取失败 @${handle}: ${r.error}`);
        } else {
          result.fetched += r.items.length;
          log.debug(`@${handle} 抓到 ${r.items.length} 条（${r.source}）`);
        }
      },
    });
    all = fetched.flatMap((r) => r.items);
    result.source = 'anonymous';
  }

  if (!all.length) {
    state.lastRunAt = startedAt;
    saveState(cfg.paths.state, pruneState(state));
    result.skipped = '一条都没抓到（网络/来源问题，看上面的 warn）';
    log.warn(result.skipped);
    return result;
  }

  const candidates = newCandidates(all, state.seen)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cfg.maxCandidates);
  result.candidates = candidates.length;

  // 敏感内容：只有"硬拦截"才丢弃；软信号打标签交给模型结合语境判断
  // （曾经的 bug：一条讨论"是否软色情"的推文因为含关键词被误杀）
  const safeCandidates = [];
  for (const item of candidates) {
    const check = checkSensitive(item, cfg);

    if (check.hard) {
      result.errors.push(`已拦截 @${item.handle}（命中「${check.hard}」）`);
      recordHistory(cfg, { id: item.id, handle: item.handle, text: item.text, url: item.url, reason: `命中硬拦截词「${check.hard}」`, action: 'sensitive' });
      state.seen[item.id] = Date.now();
      continue;
    }

    const tags = [...check.soft];
    if (check.politics && cfg.filterPolitics !== false) tags.push('政治');

    if (tags.length) {
      // 不丢弃，交给模型判断：讨论/批评不算违规
      item.sensitiveTags = tags;
      recordHistory(cfg, { id: item.id, handle: item.handle, text: item.text, url: item.url, reason: `含敏感词（${tags.join('/')}），交给模型判断`, action: 'flagged' });
    }

    safeCandidates.push(item);
  }

  if (!safeCandidates.length) {
    state.lastRunAt = startedAt;
    saveState(cfg.paths.state, pruneState(state));
    result.skipped = '候选全是敏感内容，本轮跳过';
    log.warn(result.skipped);
    return result;
  }

  candidates.length = 0;
  candidates.push(...safeCandidates);

  if (!candidates.length) {
    state.lastRunAt = startedAt;
    saveState(cfg.paths.state, pruneState(state));
    result.skipped = '没有新推文';
    log.info(result.skipped);
    return result;
  }

  log.info(`新推文 ${candidates.length} 条，交给 DeepSeek 判断…`);
  await enrichImages(cfg, candidates, log);

  const { picks, error } = await judge(candidates, cfg, `${readInterests(cfg)}\n\n${safeRule(cfg)}`);
  if (error) {
    result.errors.push(error);
    log.error(error);
  }

  // comment 模式只挑一条：一条回复只能挂在一个推文下面，挑多了像刷屏
  if (cfg.postMode === 'comment' && picks.length > 1) {
    log.info(`comment 模式只保留第一条（从 ${picks.length} 条裁到 1 条）`);
    picks.length = 1;
  }

  // 不管挑没挑中，都记成"看过"，避免下次重复消耗 token
  markSeen(state, candidates);
  state.lastRunAt = startedAt;

  if (!picks.length) {
    saveState(cfg.paths.state, pruneState(state));
    result.skipped = error ? '判断失败，本轮跳过' : '模型认为没有值得看的';
    log.info(result.skipped);
    return result;
  }

  result.picks = picks;
  const { text, dropped } = compose(picks, cfg.targetHandle || 'you');
  result.text = text;
  if (dropped > 0) log.warn(`文案超长，丢了 ${dropped} 条（想都发就调小 MAX_PICKS 或缩短理由）`);

  if (dry || cfg.postMode === 'off') {
    result.skipped = dry ? 'dry-run' : 'POST_MODE=off';
    result.posted = null;
    rememberPicks(cfg, picks, 'dry', '干跑，未发送');
    saveState(cfg.paths.state, pruneState(state));
    log.info(`[${result.skipped}] 本该发这条：\n${text}`);
    return result;
  }

  if (inQuietHours(cfg, new Date())) {
    result.skipped = '免打扰时段';
    saveState(cfg.paths.state, pruneState(state));
    log.info(result.skipped);
    return result;
  }

  const today = postsToday(state, cfg);
  if (!force && today >= cfg.maxPostsPerDay) {
    result.skipped = `今天已发 ${today} 条，达到上限 ${cfg.maxPostsPerDay}`;
    saveState(cfg.paths.state, pruneState(state));
    log.info(result.skipped);
    return result;
  }

  const gapMs = cfg.minIntervalMinutes * 60_000;
  if (!force && state.lastPostAt && Date.now() - state.lastPostAt < gapMs) {
    const mins = Math.round((Date.now() - state.lastPostAt) / 60_000);
    result.skipped = `距上一条只过了 ${mins} 分钟（下限 ${cfg.minIntervalMinutes}）`;
    saveState(cfg.paths.state, pruneState(state));
    log.info(result.skipped);
    return result;
  }

  try {
    // 发推走 cookie 会话（GraphQL CreateTweet）：v1.1 的 statuses/update 已被 X 删除。
    // 没有可用 cookie 时才退回 OAuth1 的老路（那条现在多半也会失败，但保留给付费 API 用户）。
    const session = tryLoadSession(cfg);
    // reply 模式只回复「最近 7 天内」的推；否则改成单独发一条 @ 你
    // （不然会把内容塞到几个月前的旧推下面，看起来像考古）
    let replyTo = null;
    if (cfg.postMode === 'reply' && cfg.targetHandle) {
      const latest = await latestTweet(cfg.targetHandle, cfg, session);
      const maxAgeMs = 7 * 86400_000;
      if (latest && Date.now() - latest.createdAt < maxAgeMs) {
        replyTo = latest.id;
      } else {
        log.info('目标最近 7 天没发推，改用「单独发一条 @ 你」');
      }
    } else if (cfg.postMode === 'comment') {
      // comment 模式：回复在「挑中的那条推文」下面，正文里 @ 你
      replyTo = picks[0]?.id ?? null;
      if (!replyTo) log.warn('comment 模式但没有可回复的目标，退化成单独发一条');
      else log.info(`将回复在 @${picks[0].handle} 的推文下：${picks[0].url}`);
    }

    // 发送通道：优先官方 API；额度不足（402）或强制 browser 时，用浏览器自动化
    const targetUrl =
      cfg.postMode === 'comment'
        ? picks[0]?.url ?? ''
        : replyTo
          ? `https://x.com/i/status/${replyTo}`
          : '';

    let posted = null;
    const tryApi = cfg.postTransport !== 'browser' && cfg.canPost;

    if (tryApi) {
      try {
        log.info(`用官方 API 发送（身份：${cfg.actingAs ?? '来自 .env 的 token'}）`);
        posted = await postTweet(cfg, text, { replyTo });
      } catch (err) {
        // auto 模式下任何 API 失败都回退浏览器：
        // 402（没额度）、401（token 过期且刷新失败）、429（限流）都不该让整轮失败
        if (cfg.postTransport === 'auto') {
          log.warn(`API 发送失败（${err.message.slice(0, 80)}…），改用浏览器`);
        } else {
          throw err;
        }
      }
    }

    if (!posted) {
      if (!targetUrl) throw new Error('浏览器发送需要一个目标推文地址（comment / reply 模式才有）');
      log.info(`用浏览器打开 ${targetUrl} 并回复…`);
      const context = await launchContext({ dataDir: cfg.dataDir, headless: cfg.browserHeadless });
      try {
        // 兜底超时：浏览器偶尔会卡在页面加载/选择器上，卡住会一直占着"上一轮还在跑"的锁
        const res = await Promise.race([
          replyToTweet(context, targetUrl, text),
          new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器发送超时（180 秒）')), 180_000)),
        ]);
        posted = { id: '', via: 'browser', screenshot: res?.screenshot ?? '' };
        log.info(`浏览器发送完成${res?.screenshot ? `，截图：${res.screenshot}` : ''}`);
      } finally {
        await closeContext(context);
      }
    }

    result.posted = posted;
    state.lastPostAt = Date.now();
    state.posts = [...(state.posts ?? []), { ts: Date.now(), id: posted.id, replyTo, via: posted.via ?? 'api' }];
    log.info(
      posted.id
        ? `已发出：https://x.com/i/status/${posted.id}${replyTo ? `（回复 ${replyTo}）` : ''}`
        : `已通过浏览器回复 ${replyTo}（无 API id）`,
    );
  } catch (err) {
    result.errors.push(err.message);
    state.lastError = err.message;
    log.error(`发送失败：${err.message}`);
  }

  // 记进「刷过的推文」：无论发没发出去，都留一条可回看的记录
  const action = result.posted ? 'posted' : 'failed';
  rememberPicks(cfg, picks, action, result.errors[0] ?? '');

  saveState(cfg.paths.state, pruneState(state));
  return result;
}







