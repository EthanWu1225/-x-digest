import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 审核队列。
 *
 * 设计前提：所有对外的写操作（发推 / 回复 / 私信）都**先落成草稿**，
 * 由人点「发」才真正发出。这样即使模型判断跑偏，也发不出去。
 */

const KINDS = { tweet: '发推', reply: '回复', dm: '私信' };

export function emptyQueue() {
  return { version: 1, items: [] };
}

export function loadQueue(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { ...emptyQueue(), ...parsed, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return emptyQueue();
  }
}

export function saveQueue(file, queue) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8');
  renameSync(tmp, file);
}

function newId() {
  return `d${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/**
 * 往队列里加一条草稿。
 * @param {object} queue
 * @param {{kind: 'tweet'|'reply'|'dm', text: string, target?: {id?: string, handle?: string, url?: string}, reason?: string, source?: object}} draft
 */
export function addDraft(queue, draft) {
  if (!KINDS[draft.kind]) throw new Error(`未知草稿类型：${draft.kind}`);
  if (!String(draft.text ?? '').trim()) throw new Error('草稿内容为空');

  const item = {
    id: newId(),
    kind: draft.kind,
    text: String(draft.text).slice(0, 4000),
    target: {
      id: draft.target?.id ? String(draft.target.id) : '',
      handle: draft.target?.handle ? String(draft.target.handle).replace(/^@/, '') : '',
      url: draft.target?.url ? String(draft.target.url) : '',
    },
    reason: String(draft.reason ?? '').slice(0, 500),
    source: draft.source ?? null,
    status: 'pending',
    createdAt: Date.now(),
    sentAt: null,
    resultId: '',
    error: '',
  };

  queue.items.unshift(item);
  // 只保留最近 200 条，避免文件无限涨
  queue.items = queue.items.slice(0, 200);
  return item;
}

export function listDrafts(queue, { status } = {}) {
  const items = queue.items ?? [];
  return status ? items.filter((i) => i.status === status) : items;
}

export function getDraft(queue, id) {
  return (queue.items ?? []).find((i) => i.id === id) ?? null;
}

export function rejectDraft(queue, id, reason = '') {
  const item = getDraft(queue, id);
  if (!item) throw new Error(`没有这条草稿：${id}`);
  if (item.status !== 'pending') throw new Error(`草稿状态是 ${item.status}，不能驳回`);
  item.status = 'rejected';
  item.error = reason;
  return item;
}

function localDateKey(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 今天某类动作发了几条（用于频率上限）。 */
export function sentToday(queue, kind, timeZone) {
  const today = localDateKey(timeZone);
  return (queue.items ?? []).filter(
    (i) =>
      i.kind === kind &&
      i.status === 'sent' &&
      i.sentAt &&
      localDateKey(timeZone) === new Date(i.sentAt).toLocaleDateString('en-CA', { timeZone }),
  ).length;
}

/**
 * 审核通过 → 真正发送。
 * @param {object} queue
 * @param {string} id
 * @param {import('./xsession.mjs').XSession} session
 * @param {{timeZone: string, replyDailyLimit: number, dmDailyLimit: number}} limits
 */
export async function approveDraft(queue, id, session, limits) {
  const item = getDraft(queue, id);
  if (!item) throw new Error(`没有这条草稿：${id}`);
  if (item.status !== 'pending') throw new Error(`草稿状态是 ${item.status}，不能发送`);

  const limit = item.kind === 'dm' ? limits.dmDailyLimit : limits.replyDailyLimit;
  if (Number.isFinite(limit) && limit > 0 && sentToday(queue, item.kind, limits.timeZone) >= limit) {
    throw new Error(`今天已经发过 ${limit} 条${KINDS[item.kind]}了（上限）。明天再发，或调高上限`);
  }

  try {
    let result;
    if (item.kind === 'dm') {
      if (!item.target.id) throw new Error('私信缺少收件人数字 id');
      result = await session.dm(item.target.id, item.text);
    } else if (item.kind === 'reply') {
      if (!item.target.id) throw new Error('回复缺少被回复的推文 id');
      result = await session.post(item.text, { replyTo: item.target.id });
    } else {
      result = await session.post(item.text);
    }

    item.status = 'sent';
    item.sentAt = Date.now();
    item.resultId = String(result?.id ?? '');
    item.error = '';
    return item;
  } catch (err) {
    item.status = 'failed';
    item.error = err.message;
    throw err;
  }
}

export { KINDS };
