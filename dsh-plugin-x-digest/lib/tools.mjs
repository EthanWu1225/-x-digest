/**
 * 工具定义。
 *
 * 这里刻意**不 import `@deepseek-ai/dsh-tools`**：`defineTool()` 只是把作者侧的
 * schema DSL 编译成普通对象，而 `tools.register()` 运行时只检查
 * `output.schema`（受支持的 JSON Schema 子集）与 `output.render` 是不是函数。
 * 手写普通对象带来两个好处：
 *   1. 插件对 DSH 核心包零依赖，DSH 升级/换安装方式都不会让插件在 import 阶段炸掉；
 *   2. 不需要在 profile 里解析到与宿主同版本的 dsh-tools。
 * 代价是丢掉参数自动校验，因此每个 execute 都自己做类型收敛。
 */

const text = (value) => [{ type: 'text', text: value }];

function ageLabel(createdAt) {
  const minutes = Math.max(0, Math.round((Date.now() - Number(createdAt)) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 把 /timeline 的原始条目整理成模型好读的形状。 */
export function shapeTimeline(body) {
  const items = (body?.items ?? []).map((item) => ({
    handle: String(item.handle ?? ''),
    text: String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 600),
    url: String(item.url ?? ''),
    ageMinutes: Math.max(0, Math.round((Date.now() - Number(item.createdAt ?? 0)) / 60000)),
    likes: Number(item.likes ?? 0) || 0,
    reposts: Number(item.reposts ?? 0) || 0,
    ageLabel: ageLabel(item.createdAt),
  }));
  const errors = (body?.errors ?? []).map((e) => ({
    handle: String(e.handle ?? ''),
    error: String(e.error ?? ''),
  }));
  return { items, errors };
}

const OBJ = { type: 'object', additionalProperties: false };

/**
 * @param {import('./client.mjs').XDigestClient} client
 * @param {{ baseUrl: string }} settings
 */
export function buildToolDefinitions(client, settings) {
  return [
    {
      name: 'x_timeline',
      description:
        '读取 x-digest 服务抓到的 X（推特）公开时间线，用于回答"X 上今天有什么""某人最近在说什么"。' +
        `服务地址：${settings.baseUrl}。不传 handles 时用用户配置的默认关注列表。`,
      parameters: {
        ...OBJ,
        properties: {
          handles: { type: 'string', description: '逗号分隔的账号名（不带 @）。留空则用默认关注列表。' },
          limit: { type: 'integer', description: '每个账号最多返回几条，默认 10，上限 50。' },
        },
      },
      output: {
        schema: {
          ...OBJ,
          required: ['handles', 'items', 'errors'],
          properties: {
            handles: { type: 'array', items: { type: 'string' } },
            items: {
              type: 'array',
              items: {
                ...OBJ,
                required: ['handle', 'text', 'url', 'ageMinutes', 'likes', 'reposts', 'ageLabel'],
                properties: {
                  handle: { type: 'string' },
                  text: { type: 'string' },
                  url: { type: 'string' },
                  ageMinutes: { type: 'integer' },
                  likes: { type: 'integer' },
                  reposts: { type: 'integer' },
                  ageLabel: { type: 'string' },
                },
              },
            },
            errors: {
              type: 'array',
              items: {
                ...OBJ,
                required: ['handle', 'error'],
                properties: { handle: { type: 'string' }, error: { type: 'string' } },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.items.length) {
            const detail = value.errors.map((e) => `@${e.handle}: ${e.error}`).join('；');
            return text(
              `没抓到任何推文。${detail ? `抓取错误：${detail}` : '（服务在线，可能确实没有新内容）'}`,
            );
          }
          const lines = value.items.map(
            (item) => `@${item.handle}（${item.ageLabel}，${item.likes} 赞）\n${item.text}\n${item.url}`,
          );
          const warn = value.errors.length
            ? `\n\n抓取失败：${value.errors.map((e) => `@${e.handle} ${e.error}`).join('；')}`
            : '';
          return text(`抓到 ${value.items.length} 条：\n\n${lines.join('\n\n')}${warn}`);
        },
      },
      async execute(args = {}, exec = {}) {
        const handles = String(args.handles ?? '')
          .split(',')
          .map((s) => s.trim().replace(/^@/, ''))
          .filter(Boolean);
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
        exec?.signal?.throwIfAborted?.();

        const body = await client.timeline({ handles, limit });
        const shaped = shapeTimeline(body);
        return {
          handles: handles.length ? handles : client.defaultHandles,
          items: shaped.items.slice(0, limit),
          errors: shaped.errors,
        };
      },
    },

    {
      name: 'x_digest_now',
      description:
        '让 x-digest 服务立刻跑一轮：抓取 → 让 DeepSeek 挑出用户会感兴趣的 → 拼好一条 @ 用户的推文。' +
        '默认 dry（只返回文案不发送）；只有用户明确说"现在就发"时才把 dry 设成 false。',
      parameters: {
        ...OBJ,
        properties: {
          dry: { type: 'boolean', description: 'true（默认）只生成不发送；false 会用用户账号真的发推。' },
          force: { type: 'boolean', description: 'true 绕过每日条数与最小间隔限制，慎用。' },
        },
      },
      output: {
        schema: {
          ...OBJ,
          required: ['skipped', 'picked', 'text', 'postedId', 'picks', 'errors'],
          properties: {
            skipped: { type: 'string' },
            picked: { type: 'integer' },
            text: { type: 'string' },
            postedId: { type: 'string' },
            picks: {
              type: 'array',
              items: {
                ...OBJ,
                required: ['handle', 'reason', 'url'],
                properties: {
                  handle: { type: 'string' },
                  reason: { type: 'string' },
                  url: { type: 'string' },
                },
              },
            },
            errors: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const head = value.postedId
            ? `已发送：https://x.com/i/status/${value.postedId}`
            : value.skipped
              ? `没有发送（${value.skipped}）`
              : '没有发送';
          const picks = value.picks.length
            ? '\n\n挑中的：\n' +
              value.picks.map((p, i) => `${i + 1}. @${p.handle}：${p.reason} ${p.url}`).join('\n')
            : '';
          const body = value.text ? `\n\n文案：\n${value.text}` : '';
          const errs = value.errors.length ? `\n\n错误：${value.errors.join('；')}` : '';
          return text(`${head}${picks}${body}${errs}`);
        },
      },
      async execute(args = {}, exec = {}) {
        exec?.signal?.throwIfAborted?.();
        const body = await client.digest({ dry: args.dry !== false, force: args.force === true });
        return {
          skipped: String(body?.skipped ?? ''),
          picked: Array.isArray(body?.picks) ? body.picks.length : 0,
          text: String(body?.text ?? ''),
          postedId: String(body?.posted?.id ?? ''),
          picks: (body?.picks ?? []).map((p) => ({
            handle: String(p.handle ?? ''),
            reason: String(p.reason ?? ''),
            url: String(p.url ?? ''),
          })),
          errors: (body?.errors ?? []).map((e) => String(e)),
        };
      },
    },

    {
      name: 'x_digest_status',
      description:
        '查看 x-digest 服务状态：在刷谁、有没有发推权限、看过多少条、最近发过什么。排查"为什么没收到推送"时先用它。',
      parameters: { ...OBJ, properties: {} },
      output: {
        schema: {
          ...OBJ,
          required: [
            'baseUrl',
            'online',
            'handles',
            'postMode',
            'canPost',
            'seen',
            'lastPostAt',
            'lastError',
          ],
          properties: {
            baseUrl: { type: 'string' },
            online: { type: 'boolean' },
            handles: { type: 'array', items: { type: 'string' } },
            postMode: { type: 'string' },
            canPost: { type: 'boolean' },
            seen: { type: 'integer' },
            lastPostAt: { type: 'string' },
            lastError: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const lines = [
            `服务：${value.baseUrl}（${value.online ? '在线' : '离线'}）`,
            `在刷：${value.handles.map((h) => `@${h}`).join(' ') || '（没配）'}`,
            `发推模式：${value.postMode}${value.canPost ? '' : '（凭据缺失，只能 dry）'}`,
            `已记录：${value.seen} 条看过`,
            `最近发送：${value.lastPostAt || '从未'}`,
          ];
          if (value.lastError) lines.push(`上次错误：${value.lastError}`);
          return text(lines.join('\n'));
        },
      },
      async execute() {
        try {
          const health = await client.health();
          let state = {};
          try {
            state = await client.state();
          } catch {
            state = {};
          }
          const posts = Array.isArray(state.posts) ? state.posts : [];
          const lastPostAt = posts.length ? new Date(posts[posts.length - 1].ts).toISOString() : '';
          return {
            baseUrl: settings.baseUrl,
            online: true,
            handles: Array.isArray(health.handles) ? health.handles.map(String) : [],
            postMode: String(health.postMode ?? 'unknown'),
            canPost: health.canPost === true,
            seen: Number(state.seen ?? 0) || 0,
            lastPostAt,
            lastError: String(state.lastError ?? ''),
          };
        } catch (err) {
          return {
            baseUrl: settings.baseUrl,
            online: false,
            handles: [],
            postMode: 'unknown',
            canPost: false,
            seen: 0,
            lastPostAt: '',
            lastError: String(err?.message ?? err),
          };
        }
      },
    },

    {
      name: 'x_drafts',
      description:
        '列出等待审核的草稿（回复 / 私信 / 发推）。服务把每条要发出去的话都先存成草稿，' +
        '必须人工点「发」才会真正发出。用户问"它想说什么""有什么等我批的"时用这个。',
      parameters: {
        ...OBJ,
        properties: {
          status: {
            type: 'string',
            description: 'pending（默认，待审）| sent | rejected | failed | all',
          },
        },
      },
      output: {
        schema: {
          ...OBJ,
          required: ['items', 'pending'],
          properties: {
            pending: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                ...OBJ,
                required: ['id', 'kind', 'text', 'targetHandle', 'targetUrl', 'reason', 'status', 'createdAt'],
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  text: { type: 'string' },
                  targetHandle: { type: 'string' },
                  targetUrl: { type: 'string' },
                  reason: { type: 'string' },
                  status: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.items.length) return text('没有待审草稿。');
          const kindLabel = { tweet: '发推', reply: '回复', dm: '私信' };
          const lines = value.items.map(
            (d, i) =>
              `${i + 1}. [${kindLabel[d.kind] ?? d.kind}] ${d.targetHandle ? `@${d.targetHandle} ` : ''}` +
              `${d.text}\n   id: ${d.id}${d.reason ? `\n   理由：${d.reason}` : ''}`,
          );
          return text(`待审 ${value.pending} 条：\n\n${lines.join('\n\n')}`);
        },
      },
      async execute(args = {}) {
        const status = String(args.status ?? 'pending');
        const body = await client.drafts({ status: status === 'all' ? '' : status });
        const items = (body?.items ?? []).map((d) => ({
          id: String(d.id ?? ''),
          kind: String(d.kind ?? ''),
          text: String(d.text ?? ''),
          targetHandle: String(d.target?.handle ?? ''),
          targetUrl: String(d.target?.url ?? ''),
          reason: String(d.reason ?? ''),
          status: String(d.status ?? ''),
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
        }));
        return { items, pending: Number(body?.counts?.pending ?? 0) || 0 };
      },
    },

    {
      name: 'x_review',
      description:
        '审核一条草稿：approve 会**真的用用户的小号发出去**，reject 只是丢弃。' +
        '只有在用户明确说"发吧/通过"时才用 approve；不确定就先把草稿内容贴给用户看。',
      parameters: {
        ...OBJ,
        properties: {
          id: { type: 'string', description: '草稿 id（从 x_drafts 拿）' },
          action: { type: 'string', enum: ['approve', 'reject'], description: 'approve=发出去，reject=丢弃' },
          reason: { type: 'string', description: '驳回原因，可留空' },
        },
        required: ['id', 'action'],
      },
      output: {
        schema: {
          ...OBJ,
          required: ['id', 'status', 'resultId', 'error'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            resultId: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.status === 'sent') {
            return text(`已发出：https://x.com/i/status/${value.resultId}`);
          }
          if (value.status === 'rejected') return text('已驳回，没有发出。');
          if (value.status === 'failed') return text(`发送失败：${value.error}`);
          return text(`草稿状态：${value.status}${value.error ? `（${value.error}）` : ''}`);
        },
      },
      async execute(args = {}) {
        const id = String(args.id ?? '');
        const action = String(args.action ?? '');
        if (!id) throw new Error('缺少草稿 id');
        if (!['approve', 'reject'].includes(action)) throw new Error('action 只能是 approve 或 reject');

        const body = await client.review(id, action, String(args.reason ?? ''));
        return {
          id: String(body?.id ?? id),
          status: String(body?.status ?? 'unknown'),
          resultId: String(body?.resultId ?? ''),
          error: String(body?.error ?? ''),
        };
      },
    },
  ];
}
