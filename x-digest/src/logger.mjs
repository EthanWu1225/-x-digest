import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function createLogger({ file, debug = false } = {}) {
  if (file) mkdirSync(path.dirname(file), { recursive: true });

  const write = (level, msg, extra) => {
    if (level === 'debug' && !debug) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
      extra ? ' ' + JSON.stringify(extra) : ''
    }`;
    if (level === 'error') console.error(line);
    else console.log(line);
    if (file) {
      try {
        appendFileSync(file, line + '\n');
      } catch {
        /* 日志写不进去不影响主流程 */
      }
    }
  };

  const logger = {};
  for (const level of LEVELS) logger[level] = (msg, extra) => write(level, msg, extra);
  return logger;
}
