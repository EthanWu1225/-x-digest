import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * 改 .env 里的指定键，保留注释与顺序。
 * 只认白名单里的键 —— 避免设置页把 API key / cookie 路径改坏。
 */
const ALLOWED = {
  source: 'SOURCE',
  searchQueries: 'SEARCH_QUERIES',
  searchProduct: 'SEARCH_PRODUCT',
  searchMinLikes: 'SEARCH_MIN_LIKES',
  presets: 'PRESETS',
  visionInDigest: 'VISION_IN_DIGEST',
  visionMaxImages: 'VISION_MAX_IMAGES',
  filterPolitics: 'FILTER_POLITICS',
  visionVideo: 'VISION_VIDEO',
  visionMaxVideos: 'VISION_MAX_VIDEOS',
  visionVideoFrames: 'VISION_VIDEO_FRAMES',
  watchHandles: 'WATCH_HANDLES',
  targetHandle: 'TARGET_HANDLE',
  postMode: 'POST_MODE',
  maxPicks: 'MAX_PICKS',
  maxPostsPerDay: 'MAX_POSTS_PER_DAY',
  minIntervalMinutes: 'MIN_INTERVAL_MINUTES',
  pollIntervalMinutes: 'POLL_INTERVAL_MINUTES',
  mentionWatch: 'MENTION_WATCH',
  mentionPollMinutes: 'MENTION_POLL_MINUTES',
  mentionWhitelist: 'MENTION_WHITELIST',
};

export const EDITABLE_KEYS = Object.keys(ALLOWED);

export function patchEnvFile(file, patch = {}) {
  const pairs = {};
  for (const [field, envKey] of Object.entries(ALLOWED)) {
    if (Object.hasOwn(patch, field)) pairs[envKey] = String(patch[field] ?? '').trim();
  }
  // 参数校验要在写盘前做完
  if (Object.hasOwn(pairs, 'POST_MODE') && !['off', 'reply', 'mention', 'comment'].includes(pairs.POST_MODE)) {
    throw new Error(`POST_MODE 只能是 off / reply / mention / comment，收到 "${pairs.POST_MODE}"`);
  }
  for (const key of ['MAX_PICKS', 'MAX_POSTS_PER_DAY', 'MIN_INTERVAL_MINUTES', 'POLL_INTERVAL_MINUTES', 'MENTION_POLL_MINUTES']) {
    if (Object.hasOwn(pairs, key) && pairs[key] && !/^\d+$/.test(pairs[key])) {
      throw new Error(`${key} 必须是数字`);
    }
  }
  if (Object.hasOwn(pairs, 'MENTION_WATCH') && !/^(true|false)$/i.test(pairs.MENTION_WATCH)) {
    throw new Error(`MENTION_WATCH 只能是 true / false，收到 "${pairs.MENTION_WATCH}"`);
  }
  if (Object.hasOwn(pairs, 'SOURCE') && !['handles', 'search', 'home'].includes(pairs.SOURCE)) {
    throw new Error(`SOURCE 只能是 handles / search，收到 "${pairs.SOURCE}"`);
  }
  if (Object.hasOwn(pairs, 'SEARCH_PRODUCT') && !['Latest', 'Top'].includes(pairs.SEARCH_PRODUCT)) {
    throw new Error(`SEARCH_PRODUCT 只能是 Latest / Top，收到 "${pairs.SEARCH_PRODUCT}"`);
  }
  return patchEnvKeys(file, pairs);
}

/** 通用：按 {ENV_KEY: value} 改写 .env，保留注释与顺序。 */
export function patchEnvKeys(file, pairs = {}) {
  if (!existsSync(file)) throw new Error(`找不到 .env：${file}`);

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const changed = [];

  for (const [key, raw] of Object.entries(pairs)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    const value = String(raw ?? '').trim();
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex((l) => pattern.test(l));
    const next = `${key}=${value}`;

    if (index >= 0) {
      if (lines[index] !== next) {
        lines[index] = next;
        changed.push(key);
      }
    } else {
      lines.push(next);
      changed.push(key);
    }
  }

  if (changed.length) writeFileSync(file, lines.join('\n'), 'utf8');
  return changed;
}







