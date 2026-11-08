/**
 * 测试用模块解析钩子：把 @deepseek-ai/* 指到本机 DSH 的 profile 依赖目录。
 *
 * 为什么要这个：插件在 DSH 里是装在 profile 的 node_modules 下的，所以能直接
 * import '@deepseek-ai/dsh-tools'；而工作区里没有这些包。生产安装不需要它。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const PROFILE_MODULES = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.dsh',
  'profiles',
  'node_modules',
);

function pickExport(exportsField, subpath) {
  if (!exportsField) return null;
  const entry = exportsField[subpath];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return entry.default ?? entry.import ?? entry.node ?? Object.values(entry)[0] ?? null;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@deepseek-ai/') || !PROFILE_MODULES) {
      return nextResolve(specifier, context);
    }

    const parts = specifier.split('/');
    const pkgDir = path.join(PROFILE_MODULES, parts[0], parts[1]);
    try {
      const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
      const target =
        pickExport(pkg.exports, subpath) ?? pickExport(pkg.exports, subpath + '.js') ?? pkg.module ?? pkg.main;
      if (!target) return nextResolve(specifier, context);
      return { url: pathToFileURL(path.join(pkgDir, target)).href, shortCircuit: true };
    } catch {
      return nextResolve(specifier, context);
    }
  },
});
