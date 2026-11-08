import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 发推凭据文件：data/x-tokens.json
 *
 * 里面存的是**小号**的 access token（通过三脚授权拿到），所以发推身份是小号，
 * 而不是创建开发者 App 的那个主号。consumer key/secret 仍然放在 .env 里。
 */

export function tokensFile(dataDir) {
  return path.join(dataDir, 'x-tokens.json');
}

export function loadTokens(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTokens(file, tokens) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tokens, null, 2), 'utf8');
}

export function hasTokens(file) {
  const t = loadTokens(file);
  return Boolean(t?.accessToken && t?.accessTokenSecret);
}
