# x-digest（服务本体）

这是常驻进程本体：抓取 X、筛选内容、发评论、回 @、看图看视频。
**项目总览见 [上级 README](../README.md)，部署方式见 [DEPLOY.md](DEPLOY.md)。**

## 跑起来

```bash
npm install                  # playwright-core + ffmpeg-static，不下载浏览器
cp .env.example .env         # 填 key 和 cookie
npm run session-probe        # 验证 cookie
npm run once                 # 干跑一轮（不发东西）
npm run browser:login        # 首次登录小号（发评论要用）
npm run run                  # 常驻
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm run probe` | 一次性体检：网络、账号、API key |
| `npm run session-probe` | 只验 cookie 能不能读 |
| `npm run once` | 干跑一轮，打印会发什么 |
| `npm run run` | 常驻（HTTP 服务 + 定时任务） |
| `npm run browser:login` | 弹出浏览器登录小号，登录态存进 `data/browser-profile/` |
| `npm run whoami` | 看当前 API 身份 |
| `npm run auth:start` / `auth:finish` | OAuth2 授权（要用官方 API 发推时） |

## 配置（.env）

### 必填

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 判断 + 看图 + 写文案 |
| `TARGET_HANDLE` | 摘要要 @ 谁 |

### 内容来源

| 变量 | 默认 | 说明 |
|---|---|---|
| `SOURCE` | `handles` | `handles` / `search` / `home` |
| `WATCH_HANDLES` | — | 关注账号（逗号分隔，不带 @） |
| `SEARCH_QUERIES` | — | 关键词（逗号分隔），勾分区会自动写入 |
| `SEARCH_PRODUCT` | `Top` | `Top` 热门 / `Latest` 最新 |
| `SEARCH_MIN_LIKES` | `100` | 自动拼成 `min_faves:N` |
| `PRESETS` | — | 勾了哪些分区（只影响界面回显） |

### 发推

| 变量 | 默认 | 说明 |
|---|---|---|
| `POST_MODE` | `off` | `off` / `reply` / `mention` / `comment` |
| `POST_TRANSPORT` | `auto` | `auto` / `api` / `browser` |
| `MAX_PICKS` | `2` | 每次挑几条（comment 模式强制 1） |
| `MAX_POSTS_PER_DAY` | `3` | 每日上限 |
| `MIN_INTERVAL_MINUTES` | `90` | 最小间隔 |
| `BROWSER_HEADLESS` | `true` | 浏览器是否隐藏窗口 |
| `BROWSER_EXECUTABLE` | — | 指定浏览器路径（VPS 上填 `/usr/bin/chromium`） |

### 监听 @

| 变量 | 默认 | 说明 |
|---|---|---|
| `MENTION_WATCH` | `true` | 总开关 |
| `MENTION_POLL_MINUTES` | `5` | 检查频率 |
| `MENTION_WHITELIST` | 空 | 只回这些账号，留空则只回 `TARGET_HANDLE` |
| `BOT_HANDLE` | — | 机器人自己的 handle（过滤自己的推） |

### 视觉

| 变量 | 默认 | 说明 |
|---|---|---|
| `VISION_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容地址 |
| `VISION_MODEL` | `deepseek-flash` | 支持图片的模型 |
| `VISION_API_KEY` | 空 | 留空则复用 `DEEPSEEK_API_KEY` |
| `VISION_IN_DIGEST` | `true` | 摘要时也看图 |
| `VISION_MAX_IMAGES` | `6` | 每轮最多看几张图 |
| `VISION_VIDEO` | `true` | 视频识别开关 |
| `VISION_MAX_VIDEOS` | `1` | 每轮最多看几条视频 |
| `VISION_VIDEO_FRAMES` | `6` | 每条视频抽几帧 |

### 其它

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8788` | HTTP 端口 |
| `FILTER_POLITICS` | `true` | 是否过滤政治类内容 |
| `SENSITIVE_KEYWORDS` | — | 额外敏感词（逗号分隔） |
| `POLL_INTERVAL_MINUTES` | `30` | 摘要轮询间隔 |
| `HTTPS_PROXY` | — | 访问 x.com 用（配合 `NODE_USE_ENV_PROXY=1`） |
| `NO_PROXY` | — | 国内接口放行：`api.deepseek.com,...` |

## HTTP 接口

服务默认只监听 `127.0.0.1:8788`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/state` | 运行状态 |
| GET / POST | `/config` | 读 / 改配置（写回 `.env`） |
| POST | `/digest?dry=1` | 立刻跑一轮（`dry=0` 真发） |
| GET | `/history?limit=50` | 刷过的推文 |
| GET / POST | `/prompt` | 说话风格（`prompts/mention-reply.md`） |
| GET | `/presets` | 分区预设 |
| POST | `/mentions/check` | 立刻检查 @ |
| GET / POST | `/credentials` | 凭据读写 |
| GET | `/drafts` | 审核队列 |
| POST | `/drafts/:id/approve` | 批准并发送 |

## 数据文件

```
data/
├── x-cookies.json      X 小号 cookie（auth_token/ct0）
├── x-tokens.json       OAuth2 token（用官方 API 时）
├── state.json          看过哪些推文
├── history.json        刷过的推文记录（最多 300 条）
├── mentions.json       回过哪些 @
├── browser-profile/    浏览器登录态
├── video-tmp/          视频抽帧临时目录（自动清理）
└── x-digest.log        运行日志
```

⚠️ `browser-profile/` 不能跨操作系统复制（Windows 的 cookie 用 DPAPI 加密）。

## 故障排查

| 现象 | 排查 |
|---|---|
| `连不上 x.com` | 代理没开，或 `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` 没设 |
| `鉴权失败` | cookie 过期，重新导 `auth_token` / `ct0` |
| `X 344` | 账号当日动作太多，换号或等一天 |
| `API 发送失败 402` | 没有额度，会自动回退浏览器（看日志确认） |
| `浏览器发送超时` | 页面加载慢或选择器变了，默认 180 秒兜底 |
| 看图返回空 | 模型把 token 花在思考上了，代码已加 `enable_thinking:false` |
| 视频抽帧失败 | 检查 `data/video-tmp/` 可写；不要用系统 `%TEMP%` |
