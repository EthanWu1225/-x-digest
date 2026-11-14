const URL_RE = /https?:\/\/\S+/g;
// X 的 weighted length：CJK / 全角算 2，其余算 1，链接一律算 23
const WIDE =
  /[\u1100-\u11FF\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF]/;

export function weightedLength(text) {
  const replaced = text.replace(URL_RE, 'x'.repeat(23));
  let n = 0;
  for (const ch of replaced) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function shorten(text, maxChars) {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…';
}

/**
 * 评论模式专用文案：只写一句"为什么值得看"。
 *
 * 为什么不复用 compose()：那条文案里带原推链接，而评论本来就挂在原推下面，
 * 再贴一次链接会让 X 渲染出引用卡片，看起来像"单独发了一条推"。
 */
export function composeComment(pick, targetHandle, { maxLength = 275 } = {}) {
  const reason = shorten(String(pick?.reason ?? '').trim() || '这条值得看', 70);
  const base = targetHandle ? `@${targetHandle} ${reason}` : reason;

  if (weightedLength(base) <= maxLength) return { text: base, dropped: 0 };

  // 超长就只留 @ 和最短理由
  const short = targetHandle ? `@${targetHandle} ${shorten(reason, 24)}` : shorten(reason, 24);
  return { text: short.slice(0, 280), dropped: 0 };
}

/**
 * 拼一条推文：开头 @ 你，然后每条一行，附原推链接。
 * 超长时先压缩理由，再减少条目（最少留 1 条）。
 */
export function compose(picks, targetHandle, { maxLength = 275, header = '这几条我觉得你会想看' } = {}) {
  const usable = [...picks];
  let reasonChars = 40;

  for (let round = 0; round < 8; round += 1) {
    const lines = usable.map(
      (p, i) => `${i + 1}. @${p.handle}：${shorten(p.reason || '值得一看', reasonChars)} ${p.url}`,
    );
    const text = [`@${targetHandle} ${header}：`, '', ...lines].join('\n');

    if (weightedLength(text) <= maxLength) {
      return { text, dropped: picks.length - usable.length };
    }
    if (reasonChars > 12) {
      reasonChars -= 8;
    } else if (usable.length > 1) {
      usable.pop();
      reasonChars = 24;
    } else {
      // 只剩一条还超长：砍理由到最短
      const p = usable[0];
      const fallback = `@${targetHandle} ${header}：@${p.handle} ${p.url}`;
      return { text: fallback.slice(0, 400), dropped: picks.length - 1 };
    }
  }

  const p = picks[0];
  return { text: `@${targetHandle} @${p.handle} ${p.url}`, dropped: picks.length - 1 };
}
