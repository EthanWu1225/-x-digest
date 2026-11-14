/**
 * 敏感内容过滤。
 *
 * 教训：关键词一刀切会误杀。曾经有一条推文在讨论「DeepSeek 娘是不是软色情」，
 * 因为正文含 nsfw/色情 被直接丢掉 —— 但它其实是一条**讨论**，不是内容本身。
 *
 * 所以分三层：
 *   1. 硬拦截（HARD）：极端违法内容，关键词命中直接丢，不交给任何模型
 *   2. 软信号（SOFT）：命中后**不丢弃**，而是把标签带给判断模型，让它结合语境决定
 *   3. 主题过滤（政治）：单独开关，因为很多人不希望信息流里出现政治
 */

// 只放真正不能碰的（宁少勿多，避免误杀）
const HARD = [
  'child porn', 'cp video', '恋童', '未成年裸',
  'gore video', '行刑', '斩首视频',
];

// 命中后交给模型判断（讨论、批评、提问都不算违规）
const SOFT = [
  'nsfw', 'porn', 'xxx', 'onlyfans', 'hentai', 'nude', '裸照', '色情', '软色情', '成人视频', '约炮',
  'blood', '血腥', '自杀', '自残',
  'gamble', 'casino', '博彩', '赌博', '下注',
  'scam', 'airdrop', 'rug pull', '割韭菜', '杀猪盘',
];

// 政治主题的识别词（只在「过滤政治内容」开启时生效）
const POLITICS = [
  'election', 'president', 'congress', 'senate', 'parliament', 'policy', 'sanction',
  '选举', '总统', '议会', '政策', '政治', '制裁', '人大常委会', '党委', '政府',
  'geopolitics', 'war', 'military', 'invasion',
];

export function blocklistOf(cfg) {
  const extra = (cfg?.sensitiveKeywords ?? []).filter(Boolean).map((s) => String(s).toLowerCase());
  return { hard: HARD, soft: [...new Set([...SOFT, ...extra])], politics: POLITICS };
}

/** 粗略的整词匹配：拉丁词要求前后不是字母数字，中文直接 includes。 */
function hits(haystack, term) {
  if (!term) return false;
  if (/^[a-z0-9\s]+$/i.test(term)) {
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    return re.test(haystack);
  }
  return haystack.includes(term);
}

/**
 * @returns {{ hard: string, soft: string[], politics: boolean }}
 *   hard 非空表示直接丢弃；soft 是给模型的提示；politics 表示是否命中政治主题
 */
export function checkSensitive(item, cfg) {
  const haystack = `${item?.text ?? ''} ${item?.handle ?? ''}`.toLowerCase();
  const list = blocklistOf(cfg);

  for (const word of list.hard) {
    if (hits(haystack, word)) return { hard: word, soft: [], politics: false };
  }

  const soft = list.soft.filter((w) => hits(haystack, w));
  const politics = list.politics.some((w) => hits(haystack, w));
  return { hard: '', soft, politics };
}

/** 给模型的排除规则（拼到 judge 提示词后面）。 */
export function safeRule(cfg) {
  const lines = [
    '【内容红线】',
    '1. 色情、暴力血腥、赌博、诈骗的实际内容一律不要选。**但讨论、批评、提问这些话题不算**——',
    '   比如"某产品是不是软色情""这个骗局怎么运作"属于正常讨论，可以选。',
  ];
  if (cfg?.filterPolitics !== false) {
    lines.push('2. 政治类内容（选举、政策、国际冲突、政府相关）不要选，即使很热门。');
  }
  lines.push('3. 如果候选里带了 sensitive 标签，说明它命中了敏感词，请结合上下文自行判断，不要机械排除。');
  return lines.join('\n');
}
