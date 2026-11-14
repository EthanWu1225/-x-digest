# X 速览

> 让 AI 替你刷 X（推特）：它定时读内容、挑出你值得看的，**在挑中的推文下面回复并 @ 你**；
> 你在任何评论区 @ 它，它也会看着上下文回你一句。

一个独立跑着的服务 + 一个 DeepSeek Harness 设置页插件。不依赖我的电脑、不依赖任何 AI 客户端，
开机就在后台刷。

```
每 30 分钟                              每 5 分钟
───────────                            ───────────
读内容（3 种来源）                      读你的通知
  ↓                                      ↓
筛掉重复 / 挡掉敏感                     筛出 @ 它的
  ↓                                      ↓
带图的看图，带视频的抽帧                  顺着 in_reply_to 找原推
  ↓                                      ↓
DeepSeek 判断哪条值得你看                看图 / 看视频（如果有）
  ↓                                      ↓
在评论区回复并 @ 你 ──▶ X 通知栏         现写一句回复 ──▶ 你的评论区
```

## 它能做什么

| 能力 | 说明 |
|---|---|
| **定时摘要** | 每 30 分钟抓一轮，挑 1 条，在你指定的推文下评论并 @ 你 |
| **监听 @ 并回复** | 你在任何评论区 @ 它，它读原推上下文后回你一句（只回白名单里的账号） |
| **三种内容来源** | 关注账号时间线 / 关键词搜索（8 个分区）/ 首页推荐流 |
| **看图** | 推文配图交给 DeepSeek 视觉模型描述，参与判断 |
| **看视频** | 下载 mp4 → 按整段时长均匀抽帧 → 多帧一起交给视觉模型 |
| **敏感过滤** | 三层：硬拦截 / 软信号交给模型判断 / 政治主题独立开关 |
| **刷过的推文** | 设置页里能看到它挑过、跳过、拦下的一切，带链接 |
| **可改人格** | 说话风格就是一个 markdown 文件，改完下一轮生效 |

## 目录结构

```
.
├── x-digest/                    服务本体（独立 Node 进程）
│   ├── src/                     源码（见下方"它由什么组成"）
│   ├── prompts/mention-reply.md 说话风格（可改）
│   ├── interests.md             兴趣画像（判断依据，可改）
│   ├── DEPLOY.md                四种部署方式
│   ├── Dockerfile
│   └── data/                    运行时数据（gitignore）
└── dsh-plugin-x-digest/         DeepSeek Harness 设置页插件
```

## 快速开始

### 1. 装依赖

```bash
cd x-digest
npm install          # 只有两个：playwright-core、ffmpeg-static
```

不需要下载浏览器（用你系统里的 Edge/Chrome/Chromium），也不需要 ffmpeg（`ffmpeg-static` 自带）。

### 2. 配置

```bash
cp .env.example .env
```

最少填这三项：

```ini
DEEPSEEK_API_KEY=sk-...        # 判断 + 看图 + 写文案
WATCH_HANDLES=sama,karpathy    # 关注账号模式用
TARGET_HANDLE=你的主号           # 摘要要 @ 谁
```

### 3. 拿到 X 小号的 cookie

浏览器登录小号 → 开发者工具 → Application → Cookies → `x.com`，复制两个值：

```json
// data/x-cookies.json
{ "auth_token": "...", "ct0": "..." }
```

### 4. 体检

```bash
npm run session-probe     # 验证 cookie 是否有效、能不能读到时间线
```

### 5. 干跑

```bash
npm run once              # 完整跑一轮，但不发任何东西
```

### 6. 首次登录浏览器（发评论要用）

```bash
npm run browser:login     # 弹出独立浏览器窗口，登录小号
```

这一步是为了让**发评论**能通过浏览器自动化完成（免费，不烧 API 额度）。

### 7. 常驻

```bash
npm run run               # 前台跑
```

或者装系统服务，见 [DEPLOY.md](x-digest/DEPLOY.md)：

- Windows 计划任务（开机自启）
- Linux systemd
- Docker

## 它由什么组成

### 服务端（`x-digest/src/`）

| 模块 | 职责 |
|---|---|
| `server.mjs` | HTTP 服务 + 全部 API（配置、状态、历史、提示词、鉴权） |
| `digest.mjs` | 一轮的主流程：抓 → 筛 → 看图 → 判断 → 组装 → 发 |
| `sources.mjs` | 三种来源的读取（关注/搜索/推荐流）+ 老版 timeline 解析 |
| `xsession.mjs` | cookie 会话：GraphQL 与 legacy v2 接口，读时间线/通知/搜索 |
| `browser.mjs` | Playwright 驱动本机浏览器发评论、回 @、首次登录 |
| `mentions.mjs` | 监听 @：读通知 → 取原推上下文 → 看图/视频 → 生成并发送回复 |
| `vision.mjs` | 视觉：图片下载转 base64、视频抽帧、多图问答 |
| `judge.mjs` | DeepSeek 判断哪条值得看（带 JSON 容错与残片抢救） |
| `compose.mjs` | 把挑中的推文拼成一条评论文案 |
| `safety.mjs` | 三层敏感过滤 |
| `presets.mjs` | 8 个分区预设（科技/科学/财经/政治/体育/娱乐/游戏/中文） |
| `history.mjs` / `state.mjs` | 记忆：刷过的推文、已看过的推文 |
| `xpost.mjs` / `oauth2.mjs` | 官方 API 发推通道（走 OAuth2） |
| `config.mjs` / `envfile.mjs` | 配置读取与 `.env` 回写 |
| `drafts.mjs` | 审核队列（可选，用于人工确认模式） |

### 插件端（`dsh-plugin-x-digest/`）

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主入口，注册 5 个工具 + 设置页路由 |
| `lib/client.js` | 设置页：6 个标签（摘要/监听/看图/记录/风格/凭据） |
| `lib/client.mjs` | 设置页到服务的 HTTP 客户端 |
| `lib/host-routes.mjs` | 把服务 API 代理给网页（避免跨域） |
| `lib/tools.mjs` | 对话里可用的工具：跑一轮、看状态、看草稿、审批 |

## 两个关键设计

### 1. 读写分离，写入双通道

- **读**：浏览器 cookie 走 GraphQL / legacy v2，免费，不受 API 额度限制
- **写**：优先官方 API；遇到 **402（额度不足）/401（token 失效）** 自动回退到
  **浏览器自动化**（Playwright 驱动本机 Edge/Chrome）

```ini
POST_TRANSPORT=auto    # auto（默认）/ api / browser
```

没有 API 额度也能用，这是这套东西能落地的主要原因。

### 2. 敏感内容是三层，不是关键词一刀切

曾经有个真实教训：一条讨论「某产品是不是软色情」的推文因为正文含关键词被直接丢掉——
它其实只是**讨论**。

现在的做法：

| 层级 | 处理 |
|---|---|
| **硬拦截** | 极端违法内容，命中直接丢弃 |
| **软信号** | 命中 `nsfw`/`色情`/`赌博`/`诈骗` 等只**打标签**，把标签交给模型结合语境判断 |
| **政治** | 独立开关，勾了「政治」分区会自动关掉 |

提示词里明确写了：讨论、批评、提问不算违规。

## 看图与看视频

DeepSeek 官方 API **只接受 `text` / `image_url` / `file`**，不接受 `video_url` 或视频文件
（实测会报 `unknown variant` 和 `unsupported file`）。所以：

- **图片**：本地下载 → base64 内联 → `image_url`。不用外链，因为对方服务器经常拉不到 `pbs.twimg.com`。
- **视频**：下载 mp4 → `ffmpeg` 按**整段时长**均匀抽 3–8 帧 → 多帧一起问。
  不是只看开头几秒，而是覆盖全片。

```ini
VISION_BASE_URL=https://api.deepseek.com
VISION_MODEL=deepseek-flash      # 默认，不填 VISION_API_KEY 就复用 DEEPSEEK_API_KEY
VISION_IN_DIGEST=true            # 摘要时也看图
VISION_MAX_IMAGES=6              # 每轮最多看几张图
VISION_VIDEO=true                # 视频识别开关
VISION_MAX_VIDEOS=1              # 每轮最多看几条视频
VISION_VIDEO_FRAMES=6            # 每条视频抽几帧
```

> `deepseek-flash` 默认会先「思考」，把 token 全花在 reasoning 上导致正文为空。
> 代码里对 deepseek 系模型自动加了 `enable_thinking: false`。

## 分区与内容来源

X **没有** B 站那种垂类分区（Explore 只有 Trending/News/Sports/Entertainment）。
所以「分区」用调好的关键词组代替，可多选：

`科技` `科学` `财经` `政治` `体育` `娱乐` `游戏` `中文`

勾选即保存，关键词自动合并。也可以完全手写，支持 X 搜索语法：

```
AI agent min_faves:100          只要 100 赞以上
"open source" -filter:replies   排除回复
大模型 lang:zh                   只要中文
```

## 记忆

它记得的东西都在 `data/`：

| 文件 | 记什么 |
|---|---|
| `state.json` | 看过哪些推文（避免重复推给你） |
| `history.json` | 最近 300 条刷过的推文（状态、理由、链接） |
| `mentions.json` | 回过哪些 @ |
| `data/browser-profile/` | 小号在浏览器里的登录态 |

还有两个**你手写、它只读**的：

- `interests.md` —— 兴趣画像（判断依据）
- `prompts/mention-reply.md` —— 说话风格（人格）

它**没有**的：跨轮对话记忆、对你反馈的学习。想加可以提 issue。

## 安全与边界

- `.env`、`data/`（cookie、token、浏览器 profile）都在 `.gitignore`，不会进仓库
- 写操作全部有闸门：**每天上限**（默认 3）、**最小间隔**（默认 90 分钟）、**白名单**、**敏感过滤**
- 监听 @ 只回白名单里的账号，其他人一律不理（避免变成公开的自动回复机器人）
- 在别人推文下评论是**公开可见**的，默认压到一天 3 条

## 成本

| 项 | 成本 |
|---|---|
| DeepSeek 判断 + 写文案 | 一天约几分钱 |
| 看图 | 一张图约 1000 tokens |
| 看视频 | 一条约 4000–8000 tokens（6–8 帧） |
| 读 X（cookie） | 免费 |
| 发评论（浏览器） | 免费 |
| 发评论（官方 API） | 按量付费，$5 起 |

## 常见问题

**Q: 不想让它自动发，只想看看它会挑什么？**
A: `POST_MODE=off`，或者直接点设置页的「现在跑一轮（干跑）」。

**Q: 会被封号吗？**
A: 降低风险的几个默认值：小号当机器人、一天最多 3 条、90 分钟间隔、只 @ 同一个人、
不主动关注/私信陌生人。但没有绝对安全，自己判断。

**Q: 能只部署只读版本吗？**
A: 可以。`POST_MODE=off` 就只抓不发，设置页能把结果当阅读器用。

**Q: 视频能不能看完整内容而不是抽帧？**
A: DeepSeek 不支持视频输入，抽帧是当前唯一可行的方式（已按整段均匀覆盖）。
换支持视频的模型可以做到，但需要额外 key。

## 许可

MIT
