import { XDigestClient, resolveSettings } from './client.mjs';
import { buildToolDefinitions } from './tools.mjs';
import { registerRoutes } from './host-routes.mjs';

/** 插件名（loader 用它做诊断、去重与日志归属） */
export const name = 'x-digest';

/** 只有 tools 服务存在时才挂载 */
export const inject = ['tools'];

/**
 * 挂载入口。
 *
 * 有意不 export `Config`（那需要 import @deepseek-ai/schemastery），也刻意把所有
 * 步骤包在 try/catch 里：配置写错、地址填错都只应该让这个插件的工具缺席，而绝不能
 * 把 DSH 的启动流程一起带崩。诊断信息走 ctx.logger，宿主日志里能看到。
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger?.('x-digest') ?? console;

  try {
    const settings = resolveSettings(config ?? {});
    // 第二个参数让每次请求前重新读配置：sidecar 改完立刻生效，不用重启 DSH
    const client = new XDigestClient(settings, () => resolveSettings(config ?? {}));

    const definitions = buildToolDefinitions(client, settings);
    for (const definition of definitions) ctx.tools.register(definition);

    // 设置页的后端：/api/x-digest/*
    // ⚠️ 必须在 webServer 就绪之后再挂：apply 阶段它可能还没提供，
    // 直接访问 ctx.webServer 会拿不到（第一版就是因此静默 404 的）。
    try {
      ctx.inject(['webServer'], (inner) => {
        try {
          registerRoutes(inner, client, logger);
        } catch (err) {
          logger?.warn?.(`x-digest 设置页路由挂载失败（不影响工具）：${err?.message ?? err}`);
        }
      });
    } catch (err) {
      logger?.warn?.(`x-digest 无法等待 webServer：${err?.message ?? err}`);
    }

    logger.info?.(
      `x-digest 已挂载：${definitions.length} 个工具，服务 ${settings.baseUrl}` +
        `${settings.token ? '' : '（未配置 token，服务若启用了鉴权会返回 401）'}`,
    );
  } catch (err) {
    logger.error?.(`x-digest 挂载失败，工具将不可用：${err?.message ?? err}`);
  }
}
