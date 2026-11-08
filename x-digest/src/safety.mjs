/**
 * 敏感内容过滤。
 *
 * 两层：
 *   1. 关键词预筛（便宜、快，先挡掉明显的）
 *   2. 模型侧规则（在 judge 的提示词里，让它主动跳过）
 *
 * 注意：我们只在评论里写"一句理由 + 原文链接"，不复述正文，所以风险本来就低；
 * 但把明显不宜的内容挡在门外，能避免它主动去讨论那些东西。
 */

const DEFAULT_BLOCKLIST = [
  // 中英文都放一些，宁缺毋滥
  'nsfw', 'porn', 'xxx', 'onlyfans', 'nude', 'hentai',
  '色情', '裸照', '约炮', '成人视频',
  'blood', 'gore', '血腥', '尸体', '自杀', '自残',
  'gamble', 'casino', '博彩', '赌博', '下注',
  'scam', 'airdrop', 'pump', 'rug pull', '割韭菜', '杀猪盘',
  'nazi', 'terror', '恐怖袭击',
];

export function blocklistOf(cfg) {
  const extra = (cfg?.sensitiveKeywords ?? []).filter(Boolean);
  return [...new Set([...DEFAULT_BLOCKLIST, ...extra.map((s) => String(s).toLowerCase())])];
}

/**
 * @returns {{ sensitive: boolean, matched: string }}
 */
export function checkSensitive(item, cfg) {
  const haystack = `${item?.text ?? ''} ${item?.handle ?? ''}`.toLowerCase();
  for (const word of blocklistOf(cfg)) {
    if (word && haystack.includes(word)) return { sensitive: true, matched: word };
  }
  return { sensitive: false, matched: '' };
}

/** 给模型的排除规则（拼到 judge 提示词后面）。 */
export const SAFE_RULE =
  '另外：**涉及色情、暴力血腥、赌博、诈骗、极端政治的内容一律不要选**，' +
  '即使它在你的判断里"有价值"。宁可少挑，也不要挑这类。';
