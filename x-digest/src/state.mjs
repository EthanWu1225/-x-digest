import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 状态只存三样东西：哪些推文看过、发过什么、上次跑的时间。 */
export function emptyState() {
  return { version: 1, seen: {}, posts: [], lastRunAt: 0, lastPostAt: 0, lastError: null };
}

export function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** 清理 10 天前的记录，避免 state.json 无限膨胀。 */
export function pruneState(state, { days = 10 } = {}) {
  const cutoff = Date.now() - days * 86400_000;
  for (const [id, ts] of Object.entries(state.seen)) {
    if (!(ts >= cutoff)) delete state.seen[id];
  }
  state.posts = (state.posts ?? []).filter((p) => (p?.ts ?? 0) >= cutoff);
  return state;
}

export function newCandidates(items, seen) {
  return items.filter((item) => !seen[item.id]);
}

export function markSeen(state, items) {
  const now = Date.now();
  for (const item of items) state.seen[item.id] = now;
  return state;
}
