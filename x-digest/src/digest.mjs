import { existsSync, readFileSync } from 'node:fs';
import { fetchAll, fetchSessionTimeline, fetchSearchTimeline, fetchHomeTimeline } from './sources.mjs';
import { judge } from './judge.mjs';
import { compose, composeComment } from './compose.mjs';
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

  // comment 模式也可以挑多条：每条各自挂在自己的推文下面，各写一句评论

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
  // comment 模式拆成多条消息：每条挂在自己的推文下面，文案不带原推链接
  // （带了 X 会渲染成引用卡片，看起来像单独发推）
  const messages =
    cfg.postMode === 'comment'
      ? picks.map((p) => ({
          text: composeComment(p, cfg.targetHandle || 'you').text,
          replyTo: p.id,
          url: p.url,
          handle: p.handle,
        }))
      : [{ text: compose(picks, cfg.targetHandle || 'you').text, replyTo: null, dropped: 0 }];

  result.text = messages.map((m) => m.text).join('\n---\n');
  result.messages = messages.length;
  if (cfg.postMode !== 'comment' && messages[0]?.dropped > 0) {
    log.warn(`文案超长，丢了 ${messages[0].dropped} 条（想都发就调小 MAX_PICKS 或缩短理由）`);
  }

  if (dry || cfg.postMode === 'off') {
    result.skipped = dry ? 'dry-run' : 'POST_MODE=off';
    result.posted = null;
    rememberPicks(cfg, picks, 'dry', '干跑，未发送');
    saveState(cfg.paths.state, pruneState(state));
    log.info(`[${result.skipped}] 本该发 ${messages.length} 条：\n${result.text}`);
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

  // 今天还能发几条
  const remaining = Math.max(0, cfg.maxPostsPerDay - postsToday(state, cfg));
  const toSend = force ? messages : messages.slice(0, remaining);
  if (!toSend.length) {
    result.skipped = `今天已发 ${cfg.maxPostsPerDay} 条，达到上限`;
    saveState(cfg.paths.state, pruneState(state));
    log.info(result.skipped);
    return result;
  }

  // 非 comment 模式：reply 要先找到"你最近一条推"作为回复目标
  if (cfg.postMode !== 'comment' && cfg.postMode === 'reply' && cfg.targetHandle) {
    const session = tryLoadSession(cfg);
    const latest = await latestTweet(cfg.targetHandle, cfg, session);
    const maxAgeMs = 7 * 86400_000;
    if (latest && Date.now() - latest.createdAt < maxAgeMs) {
      toSend[0].replyTo = latest.id;
    } else {
      log.info('目标最近 7 天没发推，改用「单独发一条 @ 你」');
    }
  }

  const postedAll = [];
  for (let i = 0; i < toSend.length; i += 1) {
    const m = toSend[i];

    // 多条之间留点间隔，别看着像机器人连发
    if (i > 0 && cfg.commentGapSeconds > 0) {
      log.info(`等下一条（${cfg.commentGapSeconds} 秒）…`);
      await new Promise((r) => setTimeout(r, cfg.commentGapSeconds * 1000));
    }

    const targetUrl = m.replyTo
      ? cfg.postMode === 'comment'
        ? m.url
        : `https://x.com/i/status/${m.replyTo}`
      : '';

    try {
      let posted = null;

      // 1) 官方 API
      if (cfg.postTransport !== 'browser' && cfg.canPost) {
        try {
          log.info(`用官方 API 发第 ${i + 1}/${toSend.length} 条（身份：${cfg.actingAs ?? '来自 .env 的 token'}）`);
          posted = await postTweet(cfg, m.text, { replyTo: m.replyTo });
        } catch (err) {
          if (cfg.postTransport === 'auto') log.warn(`API 发送失败（${err.message.slice(0, 70)}…），改用浏览器`);
          else throw err;
        }
      }

      // 2) 浏览器
      if (!posted) {
        if (!targetUrl) throw new Error('浏览器发送需要一个目标推文地址（comment / reply 模式才有）');
        log.info(`用浏览器打开 ${targetUrl} 并回复…`);
        const context = await launchContext({ dataDir: cfg.dataDir, headless: cfg.browserHeadless });
        try {
          // 兜底超时：卡住会一直占着"上一轮还在跑"的锁
          const res = await Promise.race([
            replyToTweet(context, targetUrl, m.text),
            new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器发送超时（180 秒）')), 180_000)),
          ]);
          posted = { id: '', via: 'browser', screenshot: res?.screenshot ?? '' };
        } finally {
          await closeContext(context);
        }
      }

      postedAll.push(posted);
      state.lastPostAt = Date.now();
      state.posts = [...(state.posts ?? []), { ts: Date.now(), id: posted.id, replyTo: m.replyTo, via: posted.via ?? 'api' }];
      log.info(
        posted.id
          ? `已发出第 ${i + 1}/${toSend.length} 条：https://x.com/i/status/${posted.id}${m.replyTo ? `（回复 ${m.replyTo}）` : ''}`
          : `已通过浏览器回复 ${m.replyTo}（第 ${i + 1}/${toSend.length} 条）`,
      );
    } catch (err) {
      result.errors.push(err.message);
      state.lastError = err.message;
      log.error(`第 ${i + 1} 条发送失败：${err.message}`);
      break; // 一条失败就停，避免连续报错刷屏
    }
  }

  result.posted = postedAll[0] ?? null;
  result.postedAll = postedAll;

  // 记进「刷过的推文」：按实际发出去的条数逐条记（发了几条就几条 posted）
  if (cfg.postMode === 'comment') {
    toSend.forEach((m, i) => {
      recordHistory(cfg, {
        id: m.replyTo,
        handle: m.handle,
        url: m.url,
        reason: m.text.replace(/^@\S+\s*/, '').slice(0, 120),
        action: postedAll[i] ? 'posted' : 'failed',
        detail: postedAll[i] ? '' : result.errors[0] ?? '',
      });
    });
    // 没轮到的（超过今日上限的）记为干跑
    messages.slice(toSend.length).forEach((m) => {
      recordHistory(cfg, {
        id: m.replyTo,
        handle: m.handle,
        url: m.url,
        reason: '超过今日上限，未发送',
        action: 'dry',
      });
    });
  } else {
    rememberPicks(cfg, picks, postedAll.length ? 'posted' : 'failed', result.errors[0] ?? '');
  }

  saveState(cfg.paths.state, pruneState(state));
  return result;
}









