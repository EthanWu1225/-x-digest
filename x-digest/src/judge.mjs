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

**只输出 id / score / reason 三个字段，绝对不要复制推文原文。**

最多输出 maxPicks 条，按 score 从高到低。`;

function stripFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * 从被截断的 JSON 里抢救 picks。
 * 模型的输出长这样：{"picks":[{"id":"123","score":85,"reason":"…"},…
 * 哪怕最后一段被切掉，前面的条目仍然可用。
 */
function salvagePicks(text) {
  const picks = [];
  for (const chunk of String(text).split(/"id"\s*:\s*"/).slice(1)) {
    const id = /^(\d{5,25})/.exec(chunk)?.[1];
    if (!id) continue;
    const score = Number(/"score"\s*:\s*(-?\d+)/.exec(chunk)?.[1] ?? 0);
    const reason = /"reason"\s*:\s*"((?:[^"\\]|\\.){0,120})"/.exec(chunk)?.[1] ?? '';
    picks.push({ id, score: Number.isFinite(score) ? score : 0, reason });
  }
  return picks;
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
    // 带图的推文会先被视觉模型描述一遍，判断时一起看
    ...(c.imageDesc ? { image: c.imageDesc.slice(0, 300) } : {}),
    ...(c.videoDesc ? { video: c.videoDesc.slice(0, 400) } : {}),
    // 命中敏感词的推文不直接丢，把标签带过来让模型结合语境判断
    ...(c.sensitiveTags?.length ? { sensitive: c.sensitiveTags.join('/') } : {}),
  }));

  const user = [
    `我关注的账号最新推文如下（JSON 数组）：`,
    JSON.stringify(payload),
    '',
    payload.some((p) => p.image) ? '说明：部分推文带 image 字段，那是配图内容的文字描述，判断时请一并参考。' : '',
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
        max_tokens: 1200,
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
    // 模型偶尔会把输出截断（或被 max_tokens 切掉），从残片里抢救出 id/score/reason
    const salvaged = salvagePicks(content);
    if (!salvaged.length) {
      return { picks: [], error: `模型输出无法解析：${String(content).slice(0, 200)}` };
    }
    parsed = { picks: salvaged };
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

