/**
 * 分区预设：X 没有 B 站那种垂类分区，用「大类关键词组」代替。
 *
 * 设计原则：
 *   · 只给**大分区**，不给细分（细分交给关键词框自己写）
 *   · 每个分区 2–3 条查询，都带 min_faves 门槛
 *   · 政治分区默认会被「政治内容过滤」挡住，勾了它就会自动关掉过滤
 */

const PRESETS = [
  {
    id: 'tech',
    name: '科技',
    hint: 'AI、开源、硬件、产品',
    queries: [
      '(AI OR LLM OR agent) min_faves:100',
      '("open source" OR github OR GPU) min_faves:150',
      '(DeepSeek OR OpenAI OR Anthropic) min_faves:100',
    ],
  },
  {
    id: 'science',
    name: '科学',
    hint: '论文、物理、生物、太空',
    queries: ['(arxiv OR paper OR research) min_faves:100', '(physics OR biology OR space) min_faves:200'],
  },
  {
    id: 'finance',
    name: '财经',
    hint: '市场、公司、宏观',
    queries: ['(stock market OR earnings) min_faves:300', '(economy OR inflation OR fed) min_faves:300'],
  },
  {
    id: 'politics',
    name: '政治',
    hint: '选举、政策、国际',
    queries: ['(election OR policy OR congress) min_faves:300', '(geopolitics OR sanctions OR diplomacy) min_faves:300'],
  },
  {
    id: 'sports',
    name: '体育',
    hint: 'NBA、足球、赛事',
    queries: ['(NBA OR football OR soccer) min_faves:300', '(Olympics OR championship OR match) min_faves:300'],
  },
  {
    id: 'entertainment',
    name: '娱乐',
    hint: '影视、音乐、明星',
    queries: ['(movie OR film OR music album) min_faves:300', '(celebrity OR trailer OR concert) min_faves:300'],
  },
  {
    id: 'gaming',
    name: '游戏',
    hint: '新作、主机、电竞',
    queries: ['(gaming OR videogame OR steam) min_faves:200', '(PlayStation OR Nintendo OR Xbox) min_faves:200'],
  },
  {
    id: 'zh',
    name: '中文',
    hint: '中文圈的热门讨论',
    queries: ['大模型 lang:zh min_faves:50', '(开源 OR 编程) lang:zh min_faves:50', '科技 lang:zh min_faves:100'],
  },
];

export function listPresets() {
  return PRESETS.map(({ id, name, hint, queries }) => ({ id, name, hint, queries }));
}

export function presetQueries(id) {
  return PRESETS.find((p) => p.id === id)?.queries ?? [];
}

/** 哪些分区属于"可能敏感"的（勾选时提示 / 自动关掉政治过滤） */
export const SENSITIVE_PRESETS = ['politics'];
