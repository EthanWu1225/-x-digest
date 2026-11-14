import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 极简 dotenv：不覆盖已存在的环境变量，容忍 # 注释与引号。 */
export function loadDotenv(file = '.env') {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const str = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const num = (key, fallback) => {
  const n = Number(str(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const bool = (key, fallback = false) => {
  const v = str(key).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const csv = (key) =>
  str(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const handle = (s) => s.replace(/^@/, '').trim();

export class ConfigError extends Error {}

export function loadConfig() {
  const root = process.cwd();
  const handles = [...new Set(csv('WATCH_HANDLES').map(handle).filter(Boolean))];
  const postMode = (str('POST_MODE', 'off') || 'off').toLowerCase();

  if (!['off', 'reply', 'mention', 'comment'].includes(postMode)) {
    throw new ConfigError(
      `POST_MODE 只能是 off / reply / mention / comment，当前是 "${postMode}"`,
    );
  }

  const cfg = {
    root,
    dataDir: path.resolve(root, str('DATA_DIR', './data')),
    interestsFile: path.resolve(root, str('INTERESTS_FILE', './interests.md')),

    handles,
    // 内容来源：handles = 关注账号；search = 关键词；home = 首页推荐流（For You）
    source: (str('SOURCE', 'handles') || 'handles').toLowerCase(),
    searchQueries: csv('SEARCH_QUERIES'),
    searchProduct: str('SEARCH_PRODUCT', 'Top'),
    // 关键词搜索的赞数门槛：低于这个数的不看（实测能挡掉绝大部分噪音）
    searchMinLikes: num('SEARCH_MIN_LIKES', 100),
    // 勾了哪些分区（只用于界面回显，关键词仍以 searchQueries 为准）
    presets: csv('PRESETS'),
    targetHandle: handle(str('TARGET_HANDLE')),
    maxPicks: num('MAX_PICKS', 2),
    maxCandidates: num('MAX_CANDIDATES', 60),
    limitPerHandle: num('LIMIT_PER_HANDLE', 20),
    fetchTimeoutMs: num('FETCH_TIMEOUT_MS', 15000),

    pollIntervalMinutes: num('POLL_INTERVAL_MINUTES', 30),
    postMode,
    maxPostsPerDay: num('MAX_POSTS_PER_DAY', 3),
    minIntervalMinutes: num('MIN_INTERVAL_MINUTES', 90),
    // 一轮里发多条评论时，两条之间的间隔（秒），避免像机器人连发
    commentGapSeconds: num('COMMENT_GAP_SECONDS', 25),
    quietStart: str('QUIET_START', '23:00'),
    quietEnd: str('QUIET_END', '08:00'),
    timeZone: str('TZ', 'Asia/Shanghai'),

    x: {
      consumerKey: str('X_CONSUMER_KEY'),
      consumerSecret: str('X_CONSUMER_SECRET'),
      accessToken: str('X_ACCESS_TOKEN'),
      accessTokenSecret: str('X_ACCESS_TOKEN_SECRET'),
      bearer: str('X_BEARER_TOKEN'),
    },

    // OAuth 2.0（新版开发者控制台给的就是这个）
    oauth2: {
      clientId: str('X_CLIENT_ID'),
      clientSecret: str('X_CLIENT_SECRET'),
      redirectUri: str('OAUTH_REDIRECT_URI', 'https://example.com'),
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      screenName: '',
    },
    deepseek: {
      apiKey: str('DEEPSEEK_API_KEY'),
      baseUrl: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: str('DEEPSEEK_MODEL', 'deepseek-chat'),
    },

    // 看图：DeepSeek 的 API 不支持图像，所以另配一个 OpenAI 兼容的视觉模型
    vision: {
      // 不单独配就用 DeepSeek 的 key（同一个账号、同一个模型）
      apiKey: str('VISION_API_KEY') || str('DEEPSEEK_API_KEY'),
      baseUrl: str('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      model: str('VISION_MODEL', 'qwen3-omni-flash'),
    },
    // 定时摘要时要不要也给带图的推文看图（更准，但慢一点、花一点钱）
    visionInDigest: bool('VISION_IN_DIGEST', true),
    visionMaxImages: num('VISION_MAX_IMAGES', 6),
    // 视频识别（抽帧 + 多图），比较费时间，每轮限量
    visionVideo: bool('VISION_VIDEO', true),
    visionMaxVideos: num('VISION_MAX_VIDEOS', 1),
    // 每条视频抽几帧（均匀覆盖全片）；帧越多越准也越慢
    visionVideoFrames: num('VISION_VIDEO_FRAMES', 6),

    server: {
      port: num('PORT', 8788),
      host: str('HOST', '127.0.0.1'),
      token: str('DIGEST_TOKEN'),
    },

    // —— 互动层（cookie 会话 + 审核队列）——
    // 发送通道：auto = 有 API 额度就用 API，402 就退浏览器；api / browser 强制其中之一
    postTransport: (str('POST_TRANSPORT', 'auto') || 'auto').toLowerCase(),
    // 浏览器发送时是否隐藏窗口（首次登录必须 false，平时 true 更安静）
    browserHeadless: bool('BROWSER_HEADLESS', true),

    // —— 监听 @ 我的提及，自动回复 ——
    mentionWatch: bool('MENTION_WATCH', true),
    mentionPollMinutes: num('MENTION_POLL_MINUTES', 5),
    // 只回白名单里的人（留空则回 TARGET_HANDLE）
    mentionWhitelist: [],
    botHandle: handle(str('BOT_HANDLE')),

    // 敏感词额外名单（逗号分隔，会叠加内置清单）
    sensitiveKeywords: csv('SENSITIVE_KEYWORDS'),
    // 是否过滤政治类内容（选了「政治」分区时可以关掉）
    filterPolitics: bool('FILTER_POLITICS', true),

    session: {
      // 小号的 cookie：{ "auth_token": "...", "ct0": "..." }
      cookiesFile: path.resolve(root, str('X_COOKIES_FILE', './data/x-cookies.json')),
      // 私信只允许发给白名单里的人（数字 id 或 @handle），绝不群发
      dmWhitelist: csv('DM_WHITELIST').map((s) => s.trim()),
      replyDailyLimit: num('REPLY_DAILY_LIMIT', 5),
      dmDailyLimit: num('DM_DAILY_LIMIT', 3),
      // 审核队列是否强制（默认强制：草稿必须人点「发」）
      reviewRequired: bool('REVIEW_REQUIRED', true),
      timeoutMs: num('X_SESSION_TIMEOUT_MS', 20000),
    },

    debug: bool('DEBUG', false),
  };

  // 授权拿到的 token 优先于 .env 里的（.env 里的通常属于创建 App 的那个账号）
  const tokensPath = path.join(cfg.dataDir, 'x-tokens.json');
  try {
    const tokens = JSON.parse(existsSync(tokensPath) ? readFileSync(tokensPath, 'utf8') : 'null');
    if (tokens?.accessToken) {
      if (tokens.refreshToken || tokens.expiresAt) {
        // OAuth 2.0
        cfg.oauth2.accessToken = tokens.accessToken;
        cfg.oauth2.refreshToken = tokens.refreshToken ?? '';
        cfg.oauth2.expiresAt = Number(tokens.expiresAt) || 0;
        cfg.oauth2.screenName = tokens.screenName ?? '';
      }
      if (tokens.accessTokenSecret) {
        // OAuth 1.0a（老方案，保留兼容）
        cfg.x.accessToken = tokens.accessToken;
        cfg.x.accessTokenSecret = tokens.accessTokenSecret;
      }
      cfg.actingAs = tokens.screenName || cfg.actingAs || '(已授权账号)';
    }
  } catch {
    /* 文件坏了就当没有，走 .env */
  }

  cfg.canPost = Boolean(
    (cfg.oauth2.clientId && cfg.oauth2.clientSecret && cfg.oauth2.accessToken) ||
      (cfg.x.consumerKey && cfg.x.consumerSecret && cfg.x.accessToken && cfg.x.accessTokenSecret),
  );

  // comment 模式也能挑多条：每条各挂在自己的推文下面，一轮最多 5 条封顶
  if (cfg.postMode === 'comment') cfg.maxPicks = Math.min(cfg.maxPicks, 5);

  // 提及白名单：没显式配就只认 TARGET_HANDLE（你的主号）
  const whitelist = csv('MENTION_WHITELIST').map(handle).filter(Boolean);
  cfg.mentionWhitelist = whitelist.length ? whitelist : cfg.targetHandle ? [cfg.targetHandle] : [];

  cfg.paths = {
    state: path.join(cfg.dataDir, 'state.json'),
    dir: cfg.dataDir,
    log: path.join(cfg.dataDir, 'x-digest.log'),
    queue: path.join(cfg.dataDir, 'drafts.json'),
  };
  cfg.envFile = path.resolve(root, '.env');

  return cfg;
}

export function validateForRun(cfg) {
  const problems = [];
  const hasCookies = existsSync(cfg.session.cookiesFile);
  if (!cfg.handles.length) problems.push('WATCH_HANDLES 为空：不知道要刷谁');
  if (!cfg.deepseek.apiKey) problems.push('DEEPSEEK_API_KEY 为空：没法判断"什么值得看"');
  // 有 cookie 会话就用会话发（当前唯一可行路径）；否则才要求 OAuth1 那四项
  if (cfg.postMode !== 'off' && !hasCookies && !cfg.canPost) {
    problems.push(
      `POST_MODE=${cfg.postMode} 但没有可用的发送方式：要么放一份 cookie 到 ${cfg.session.cookiesFile}，` +
        '要么填 X_CONSUMER_* / X_ACCESS_TOKEN* 四项',
    );
  }
  if (cfg.postMode !== 'off' && !cfg.targetHandle) {
    problems.push('POST_MODE 不是 off 但 TARGET_HANDLE 为空：不知道要 @ 谁');
  }
  return problems;
}






