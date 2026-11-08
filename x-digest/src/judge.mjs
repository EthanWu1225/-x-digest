const SYSTEM = `你是一个人的私人 X（推特）信息筛选官。

你只做一件事：从一批推文里，挑出"这个人大概会觉得值得一看"的那几条。
判断标准（按重要性排序）：
1. 和他 interests 里写的主题直接相关，且带来新信息（不是复读、不是纯情绪、不是广告）；
2. 有实质内容：数据、结论、源码、论文、发布、踩坑经验、一手现场；
3. 少见但可能对他有用（他关心领域里的重要信号）；
4. 明确排除：抽奖、meme、纯政治互撕、带货、标题党、无信息量的日常。

宁可少挑，不要凑数。没有一条够格就返回空数组。

只输出 JSON，不要任何解释、不要 markdown 代码块：
{"picks":[{"id":"<推文id>","score":85,"reason":"20字以内，说清为什么值得他看"}]}

最多输出 maxPicks 条，按 score 从高到低。`;

function stripFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * 让 DeepSeek 挑出值得看的推文。
 * @returns {Promise<{picks: Array<{id:string,score:number,reason:string}>, error?: string}>}
 */
export async function judge(candidates, cfg, interests) {
  if (!candidates.length) return { picks: [] };

  const payload = candidates.map((c) => ({
    id: c.id,
    author: `@${c.handle}`,
    text: c.text.slice(0, 420),
    likes: c.likes,
    reposts: c.reposts,
  }));

  const user = [
    `我关注的账号最新推文如下（JSON 数组）：`,
    JSON.stringify(payload),
    '',
    `我的兴趣描述：`,
    interests.trim() || '（未填写，请按"AI/技术/产品/开源"这类通用高价值标准判断）',
    '',
    `maxPicks = ${cfg.maxPicks}`,
  ].join('\n');

  let res;
  try {
    res = await fetch(`${cfg.deepseek.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.deepseek.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.deepseek.model,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return { picks: [], error: `DeepSeek 请求失败：${err.message}` };
  }

  const raw = await res.text();
  if (!res.ok) {
    return { picks: [], error: `DeepSeek HTTP ${res.status}: ${raw.slice(0, 300)}` };
  }

  let content;
  try {
    content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? '';
  } catch {
    return { picks: [], error: `DeepSeek 响应不是 JSON：${raw.slice(0, 200)}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch {
    return { picks: [], error: `模型输出无法解析：${String(content).slice(0, 200)}` };
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const picks = [];
  for (const p of Array.isArray(parsed?.picks) ? parsed.picks : []) {
    const item = byId.get(String(p?.id ?? ''));
    if (!item) continue; // 模型编造 id 直接丢掉
    const score = Number(p?.score);
    picks.push({
      ...item,
      score: Number.isFinite(score) ? score : 0,
      reason: String(p?.reason ?? '').slice(0, 80),
    });
    if (picks.length >= cfg.maxPicks) break;
  }

  return { picks };
}
