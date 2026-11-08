# X 速览 —— 让 agent 自己刷 X，然后在评论区 @ 你

一套「替你刷 X（推特）」的工具：定时读关注账号或关键词搜索 → 用 DeepSeek 挑出值得看的 →
在挑中的推文下面回复并 @ 你；另外还会监听别人 @ 你，并自动回一句。

仓库里有两部分：

| 目录 | 是什么 |
|---|---|
| [`x-digest/`](x-digest/README.md) | **服务本体**。独立 Node 进程，负责抓取、筛选、评论、回 @。可跑在本机（计划任务），也可跑在 VPS |
| [`dsh-plugin-x-digest/`](dsh-plugin-x-digest/README.md) | **DSH 插件**。在 DeepSeek Harness 的设置里加一页「X 速览」，用来看状态、改配置、看刷过的推文 |

## 它长什么样

```
每 30 分钟
  → 读内容（关注账号的时间线 / 关键词搜索 / 首页推荐流）
  → DeepSeek 挑 1 条（带赞数门槛 + 敏感词过滤）
  → 在挑中的推文下面回复：「@你 这几条我觉得你会想看：…」

每 5 分钟
  → 读通知，筛出 @ 你的
  → DeepSeek 现写一句回复
  → 在你那条推文下面回复
```

## 两个关键设计

**1. 读写分离**
- **读**用浏览器 cookie（`auth_token` + `ct0`），走 GraphQL，免费
- **写**优先走官方 API；额度不足（402）时自动切换到**浏览器自动化**（Playwright 驱动本机 Edge）

**2. 敏感内容两层过滤**
- 关键词预筛（命中就不交给模型）
- 模型侧规则（色情/暴力/赌博/诈骗/极端政治一律不选）
- 被拦下的内容会记进「刷过的推文」，标成 `敏感·已跳过`

## 快速开始

```bash
cd x-digest
cp .env.example .env        # 填 DeepSeek key、X 应用凭据
npm i                        # 装 playwright-core（用本机 Edge，不下载浏览器）
npm run session-probe        # 验证 cookie 是否有效
npm run browser:login        # 首次登录小号（存进独立 profile）
npm run once                 # 干跑一轮，不发任何东西
npm run run                  # 常驻
```

Windows 上想开机自启，用 `start-service.cmd` + 计划任务（见 README）。

## 需要的凭据

| 凭据 | 用途 | 免费？ |
|---|---|---|
| DeepSeek API key | 判断什么值得看、写回复 | 按量计费，一天几分钱 |
| X 小号的 cookie（auth_token / ct0） | 读时间线、通知 | 免费 |
| X 开发者 App（Client ID/Secret） | 走官方 API 发推（可选） | 发推要额度，$5 起 |

**只读不写也能用** —— 不配开发者 App，就是把筛选结果放在设置页里自己看。

## 安全

- `.env`、`data/`（cookie、token、浏览器 profile）都在 `.gitignore` 里，不会进仓库
- 所有对外写操作都有闸门：每天上限、最小间隔、白名单、敏感词过滤
- 在别人推文下评论会公开可见，默认压在一天 3 条

## 许可

MIT
