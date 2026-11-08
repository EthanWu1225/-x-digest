import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 刷过的推文记录（对应设置页那张卡片墙）。
 *
 * 只存必要的展示信息，不存完整正文（避免把敏感内容长期留在磁盘上）。
 */

export function historyFile(cfg) {
  return path.join(cfg.dataDir, 'history.json');
}

export function loadHistory(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(historyFile(cfg), 'utf8'));
    return Array.isArray(parsed?.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

export function saveHistory(cfg, history) {
  const file = historyFile(cfg);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(history, null, 2), 'utf8');
}

/**
 * 记一条。
 * @param {object} cfg
 * @param {{id:string, handle:string, text?:string, url:string, reason?:string,
 *          action:'posted'|'dry'|'skipped'|'sensitive'|'failed', detail?:string}} record
 */
export function recordHistory(cfg, record) {
  const history = loadHistory(cfg);
  if (history.items.some((i) => i.id === record.id && i.action === record.action)) return;

  history.items.unshift({
    id: String(record.id),
    handle: String(record.handle ?? ''),
    text: String(record.text ?? '').replace(/\s+/g, ' ').slice(0, 160),
    url: String(record.url ?? ''),
    reason: String(record.reason ?? '').slice(0, 200),
    action: record.action,
    detail: String(record.detail ?? '').slice(0, 200),
    at: Date.now(),
  });

  history.items = history.items.slice(0, 300);
  saveHistory(cfg, history);
}
