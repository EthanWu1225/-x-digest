/**
 * 用「小号的浏览器 cookie」访问 X。
 *
 * 2026-11 实测结论（这段是踩坑记录，改代码前先看）：
 *   ✗ /1.1/statuses/update.json     已删除（404）——不能再用它发推/回复
 *   ✗ /1.1/account/verify_credentials.json  已删除（404）
 *   ✗ /1.1/users/show.json          已删除（404）
 *   ✗ /1.1/statuses/home_timeline.json      200 但永远返回空
 *   ✓ /1.1/dm/new2.json             存活（缺参数回 422）
 *   ✓ /1.1/dm/inbox_initial_state.json     存活，可当鉴权探针
 *   ✓ GraphQL CreateTweet / UserTweets / TweetDetail / UserByScreenName  全部可用
 *
 * 所以：读和发都走 GraphQL（x.com/i/api/graphql），私信走 v1.1。
 */

import { existsSync, readFileSync } from 'node:fs';

export const PUBLIC_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const API = 'https://api.x.com';
const WEB = 'https://x.com';

/**
 * 这些 queryId 是从 x.com 的 main bundle 里抓出来的，X 改版就会变。
 * 变了的症状：GraphQL 返回 404，或 "query not found"。
 * 换新值的办法：重新下载 https://abs.twimg.com/responsive-web/client-web/main.*.js，
 * 搜 `queryId:"XXXX",operationName:"CreateTweet"`。
 */
export const QUERY_IDS = {
  CreateTweet: 'l4hk8uVGvR-a8kzQ4nOhPA',
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  UserTweets: 'Rf0Oc_XSVYjASOj-Jbz3Xg',
  TweetDetail: 'qpemjmVMoTWDvcRT43JIVQ',
  UserByScreenName: 'AMIBMjtxEEATh4z8V9GtRg',
  SearchTimeline: 'vLHjqbDv7TPFMBkIIO1nOA',
};

/** 搜索用的 feature 开关（实测可用）。 */
const FEATURES_SEARCH = {
  rweb_video_screen_enabled: false,
  payments_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** 用户类 GraphQL 操作的 feature 开关（实测可用的一组）。 */
const FEATURES_USER = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

/** 发推用的 feature 开关（实测可用）。 */
const FEATURES_CREATE = {
  ...FEATURES_USER,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_video_timestamps_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

export class XSessionError extends Error {
  constructor(message, { status, code, retryAfter } = {}) {
    super(message);
    this.name = 'XSessionError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function explainStatus(status, bodyText) {
  if (status === 401) return 'cookie 失效或未登录（auth_token / ct0 不对，或小号已在别处登出）';
  if (status === 403) return '被拒绝：账号可能需要验证，或该操作被风控拦截';
  if (status === 404) return '接口不存在（X 改版了，queryId 需要更新）';
  if (status === 422) return `参数不被接受：${bodyText.slice(0, 160)}`;
  if (status === 429) return '被限流：等一会儿，或降低频率';
  return `HTTP ${status}：${bodyText.slice(0, 200)}`;
}

/** 从 GraphQL 的任意嵌套结构里挖出 tweet 节点（结构经常调整，所以用遍历）。 */
function collectTweets(node, out = [], depth = 0) {
  // GraphQL 的嵌套很深：data.user.result.timeline.timeline.instructions[].entries[]
  // .content.itemContent.tweet_results.result 已经是第 13 层，所以别把上限设小。
  if (!node || typeof node !== 'object' || depth > 30) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectTweets(item, out, depth + 1);
    return out;
  }
  if (node.rest_id && node.legacy && typeof node.legacy.full_text === 'string') {
    out.push(node);
    return out; // 不再往 tweet 内部挖，避免重复
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectTweets(v, out, depth + 1);
  }
  return out;
}

/** GraphQL 的 tweet 节点 → 内部结构。 */
/** 从 media 里挑码率最高的 mp4 地址。 */
function bestVideoUrl(media = []) {
  const variants = media
    .flatMap((m) => m.video_info?.variants ?? [])
    .filter((v) => v.content_type === 'video/mp4' && v.url);
  variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return variants[0]?.url ?? '';
}

export function tweetNodeToItem(node) {
  const legacy = node.legacy ?? {};
  const userResult = node.core?.user_results?.result ?? {};
  const handle = userResult.legacy?.screen_name ?? userResult.core?.screen_name ?? '';
  const text =
    node.note_tweet?.note_tweet_results?.result?.text ??
    legacy.full_text ??
    '';
  const createdAt = Date.parse(legacy.created_at ?? '') || null;
  const media = legacy.entities?.media ?? legacy.extended_entities?.media ?? [];

  if (!legacy.id_str && !node.rest_id) return null;
  if (!text || !createdAt) return null;
  if (legacy.in_reply_to_status_id_str) return null;
  if (/^RT @/.test(text)) return null;

  const id = String(legacy.id_str ?? node.rest_id);
  return {
    id,
    handle,
    text,
    createdAt,
    likes: Number(legacy.favorite_count ?? 0) || 0,
    reposts: Number(legacy.retweet_count ?? 0) || 0,
    replies: Number(legacy.reply_count ?? 0) || 0,
    images: media.map((m) => m.media_url_https ?? m.media_url).filter(Boolean),
    videoUrl: bestVideoUrl(media),
    isVideo: media.some((m) => m.type === 'video' || m.type === 'animated_gif'),
    url: `https://x.com/${handle || 'i'}/status/${id}`,
  };
}

export class XSession {
  constructor({ authToken, ct0, timeoutMs = 20000, baseUrl = API, webBase = WEB }) {
    this.authToken = authToken;
    this.ct0 = ct0;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.webBase = webBase;
    this.me = null;
  }

  static fromCookiesFile(parsed) {
    const authToken = String(parsed?.auth_token ?? '').trim();
    const ct0 = String(parsed?.ct0 ?? '').trim();
    if (!authToken || !ct0) throw new XSessionError('cookie 文件里缺 auth_token 或 ct0');
    // X_API_BASE / X_WEB_BASE 只给测试用；正常部署不要设
    return new XSession({
      authToken,
      ct0,
      baseUrl: process.env.X_API_BASE?.trim() || API,
      webBase: process.env.X_WEB_BASE?.trim() || WEB,
    });
  }

  #headers(json = false) {
    return {
      authorization: `Bearer ${PUBLIC_BEARER}`,
      'x-csrf-token': this.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      cookie: `auth_token=${this.authToken}; ct0=${this.ct0}`,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      accept: '*/*',
      referer: 'https://x.com/',
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  async #send(url, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.#headers(Boolean(body)),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new XSessionError(`连不上 x.com：${err.message}（检查代理是否开着）`);
    }

    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      throw new XSessionError(explainStatus(res.status, text), {
        status: res.status,
        code: parsed?.errors?.[0]?.code,
        retryAfter: res.headers.get('x-rate-limit-reset'),
      });
    }
    if (parsed?.errors?.length) {
      const first = parsed.errors[0];
      // 344 = 账号级发推限制：新号 / 没绑手机号 / 当天额度用完，都是它
      if (first.code === 344) {
        throw new XSessionError(
          'X 拒绝发送：这个小号的发推额度用完了（code 344）。' +
            '常见原因是账号太新、没绑手机号，或当天额度耗尽。' +
            '先用浏览器手动发一条试试：手动也发不出去就是账号限制，绑手机号或等一天。',
          { status: res.status, code: 344 },
        );
      }
      throw new XSessionError(`X 返回错误：${first.message ?? JSON.stringify(first)}`, {
        status: res.status,
        code: first.code,
      });
    }
    return parsed;
  }

  async #graphqlGet(op, variables, features = FEATURES_USER) {
    const qs = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(features),
    });
    return this.#send(`${this.webBase}/i/api/graphql/${QUERY_IDS[op]}/${op}?${qs}`);
  }

  async #graphqlPost(op, variables, features = FEATURES_CREATE) {
    return this.#send(`${this.webBase}/i/api/graphql/${QUERY_IDS[op]}/${op}`, {
      method: 'POST',
      body: { variables, features },
    });
  }

  /** 鉴权探针：DM 收件箱是当前少数存活、且需要登录的 v1.1 接口。 */
  async checkAuth() {
    const body = await this.#send(`${this.baseUrl}/1.1/dm/inbox_initial_state.json`);
    const users = body?.inbox_initial_state?.users ?? {};
    return { ok: true, usersCount: Object.keys(users).length };
  }

  /** @handle → 数字 id（发私信、读时间线都要）。 */
  async lookupUserId(handle) {
    const clean = String(handle).replace(/^@/, '');
    const body = await this.#graphqlGet('UserByScreenName', {
      screen_name: clean,
      withSafetyModeUserFields: true,
    });
    const id = body?.data?.user?.result?.rest_id;
    if (!id) throw new XSessionError(`查不到用户 @${clean}`);
    const name = body?.data?.user?.result?.legacy?.name ?? clean;
    return { id: String(id), handle: clean, name };
  }

  /** 某个账号最近的原创推文。返回内部结构数组。 */
  async userTimeline(handle, { count = 20 } = {}) {
    const user = await this.lookupUserId(handle);
    const body = await this.#graphqlGet('UserTweets', {
      userId: user.id,
      count: Math.min(Math.max(count, 5), 100),
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: false,
      withV2Timeline: true,
    });
    return collectTweets(body).map(tweetNodeToItem).filter(Boolean);
  }

  /**
   * 按关键词搜索近期推文（相当于「分区」）。
   * @param {string} query 支持 X 搜索语法，比如 `AI agent -filter:replies`
   * @param {{count?: number, product?: 'Latest'|'Top'}} opts
   */
  async search(query, { count = 20, product = 'Latest' } = {}) {
    const body = await this.#send(
      `${this.webBase}/i/api/graphql/${QUERY_IDS.SearchTimeline}/SearchTimeline`,
      {
        method: 'POST',
        body: {
          variables: {
            rawQuery: query,
            count: Math.min(Math.max(count, 5), 100),
            querySource: 'typed_query',
            product: product === 'Top' ? 'Top' : 'Latest',
          },
          features: FEATURES_SEARCH,
        },
      },
    );
    return collectTweets(body).map(tweetNodeToItem).filter(Boolean);
  }

  /** 一条推文所在的会话（含回复）。用于「回评论」。 */
  async conversation(tweetId) {
    const body = await this.#graphqlGet('TweetDetail', {
      focalTweetId: String(tweetId),
      with_rux_injections: false,
      rankingMode: 'Relevance',
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: true,
      withVoice: true,
    });
    const all = collectTweets(body).map(tweetNodeToItem).filter(Boolean);
    const root = all.find((t) => t.id === String(tweetId)) ?? all[0] ?? null;
    const replies = all.filter((t) => t.id !== root?.id);
    return { root, replies };
  }

  /** 发推或回复。 */
  async post(text, { replyTo } = {}) {
    if (!text?.trim()) throw new XSessionError('内容为空');
    if ([...text].length > 280) throw new XSessionError(`内容 ${[...text].length} 字符，超过 280`);

    const variables = {
      tweet_text: text,
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    };
    if (replyTo) variables.reply = { in_reply_to_tweet_id: String(replyTo), exclude_reply_user_ids: [] };

    const body = await this.#graphqlPost('CreateTweet', variables);
    const result = body?.data?.create_tweet?.tweet_results?.result;
    const id = result?.rest_id ?? result?.tweet?.rest_id;
    if (!id) throw new XSessionError(`发推返回异常：${JSON.stringify(body).slice(0, 300)}`);
    return { id: String(id), text: result?.legacy?.full_text ?? text };
  }

  /** 私信（v1.1 仍存活）。recipientId 是数字 id。 */
  async dm(recipientId, text) {
    if (!text?.trim()) throw new XSessionError('私信内容为空');
    const query = new URLSearchParams({
      text,
      recipient_ids: String(recipientId),
      cards_platform: 'Web-12',
      include_cards: '1',
      include_quote_count: 'true',
      dm_users: 'false',
    });
    const body = await this.#send(`${this.baseUrl}/1.1/dm/new2.json?${query}`, { method: 'POST' });
    return { id: String(body?.id ?? ''), text };
  }

  /** 读「@ 我」的通知（v2 老接口，实测仍存活）。 */
  async mentions({ count = 20 } = {}) {
    return this.#send(
      `${this.webBase}/i/api/2/notifications/mentions.json?count=${Math.min(Math.max(count, 5), 50)}&include_ranked_timeline=true`,
    );
  }

  /**
   * 读「全部通知」。
   * 实测：mentions 那个标签页索引会滞后，all 更及时，所以监听 @ 用这个自己筛。
   */
  async notifications({ count = 20 } = {}) {
    return this.#send(`${this.webBase}/i/api/2/notifications/all.json?count=${Math.min(Math.max(count, 5), 50)}`);
  }

  /**
   * 首页推荐流（For You）。
   * 老 v2 接口仍存活；必须带 tweet_mode=extended，否则正文为空。
   */
  async homeTimeline({ count = 20 } = {}) {
    return this.#send(
      `${this.webBase}/i/api/2/timeline/home.json?count=${Math.min(Math.max(count, 5), 50)}&tweet_mode=extended&include_entities=true`,
    );
  }

  /**
   * 能力探针：只读，不会发任何东西。
   * @param {{handle?: string}} opts 用哪个账号验证读能力
   */
  async probe({ handle } = {}) {
    const result = { auth: null, read: null, detail: null, errors: [] };

    try {
      result.auth = await this.checkAuth();
    } catch (err) {
      result.auth = { ok: false, error: err.message };
      result.errors.push(`鉴权: ${err.message}`);
      return result; // cookie 不行，后面不用试
    }

    const target = handle;
    if (!target) {
      result.read = { ok: false, error: '没有指定验证用的账号（WATCH_HANDLES 为空）' };
      return result;
    }

    try {
      const items = await this.userTimeline(target, { count: 5 });
      result.read = { ok: true, handle: target, count: items.length };
      if (items[0]) {
        const conv = await this.conversation(items[0].id);
        result.detail = { ok: true, replies: conv.replies.length };
      }
    } catch (err) {
      result.read = { ok: false, error: err.message };
      result.errors.push(`读时间线: ${err.message}`);
    }

    return result;
  }
}

/** 从 cfg.session.cookiesFile 读 cookie 并建会话。 */
export function loadSessionFromFile(cfg) {
  const file = cfg.session?.cookiesFile;
  if (!file) throw new XSessionError('没有配置 X_COOKIES_FILE');
  if (!existsSync(file)) {
    throw new XSessionError(
      `没有 cookie 文件：${file}。把 { "auth_token": "...", "ct0": "..." } 写进去再试`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new XSessionError(`cookie 文件不是合法 JSON：${err.message}`);
  }
  const session = XSession.fromCookiesFile(parsed);
  session.timeoutMs = cfg.session.timeoutMs ?? session.timeoutMs;
  return session;
}

