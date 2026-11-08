# x-digest —— 让 DeepSeek 自己刷 X，然后 @ 你

```
  ┌────────────┐   抓公开时间线   ┌─────────────┐  挑出你会感兴趣的   ┌──────────────┐
  │  你关注的   │ ──────────────▶ │  x-digest   │ ─────────────────▶ │  DeepSeek    │
  │  X 账号     │  (无需登录)      │  (VPS 常驻) │                    │  API         │
  └────────────┘                 └──────┬──────┘                    └──────────────┘
                                        │ 拼文案（≤280 加权字符）
                                        ▼
                              ┌──────────────────────┐
                              │ 用你的机器人账号发出   │
                              │ @ 你 / 回复你最近一条  │ ──▶ X 通知栏
                              └──────────────────────┘
```

一句话：**每 30 分钟抓一遍你关注的人，让 DeepSeek 判断哪 1–2 条值得你看，然后用一个 X 账号 @ 你。**

---

## 先看这三条前提（缺一条就跑不起来）

1. **这台机器必须能直连 x.com。** 国内 VPS（阿里云/腾讯云）一样出不去，必须是海外机器，或者本机有代理。上机第一件事就是 `npm run probe`，它会把网络、账号、API key 一次性验完。
2. **一个能发推的 X 账号。** 到 [developer.x.com](https://developer.x.com) 建 App，权限勾 **Read and write**，拿 Consumer Key/Secret + Access Token/Secret 四个值。免费档每月 500 条发推额度，够用。
   - ⚠️ 强烈建议**用小号当机器人**，别用你主号。自动发推 + 频繁 @ 同一个人是 X 风控的高发组合。
   - 改了权限之后要**重新生成一次 Access Token**，否则拿到的 token 只有读权限（典型症状：发推返回 403）。
3. **DeepSeek API key**（[platform.deepseek.com](https://platform.deepseek.com/api_keys)），用来判断"什么值得看"。

---

## 快速开始

在本机先把 `.env` 写好，或者直接上 VPS 再配：

```bash
# 0. 目录传到 VPS
scp -r x-digest you@vps:~/

# 1. 装依赖（真的没有依赖，只是确认 Node >= 20）
ssh you@vps 'node -v'

# 2. 配置
cd ~/x-digest
cp .env.example .env
nano .env        # 至少填 WATCH_HANDLES / TARGET_HANDLE / DEEPSEEK_API_KEY

# 3. 体检：网络通不通、账号能用吗、key 对不对
npm run probe

# 4. 干跑一轮：它抓到什么、挑了什么、准备发什么（不会真的发）
npm run once

# 5. 满意了，把 .env 里的 POST_MODE 改成 reply，然后常驻
npm run run
```

`npm run once` 的输出长这样：

```
── 兴趣画像 ──────────────────────────────
- AI 工程实践：推理优化、上下文工程、agent 框架、评测方法
──────────────────────────────────────────

抓取 58 条 / 新 12 条 / 挑中 2 条
[dry-run] 本该发这条：
@your_handle 这几条我觉得你会想看：

1. @karpathy：新论文把 KV cache 压到 1/4，有实测 https://x.com/karpathy/status/…
2. @deepseek_ai：V3 推理成本对比表，附完整数据 https://x.com/deepseek_ai/status/…
```

---

## 三种发推模式

| `POST_MODE` | 行为 | 适用 |
|---|---|---|
| `off`（默认） | 只打印，永不发送 | 先看效果、调兴趣画像 |
| `reply` | **回复你最近一条推** | 推荐。会出现在你的会话里，触发通知，而且不会在你主页刷出新推 |
| `mention` | 单独发一条 @ 你的推 | 你几乎不发推、或者想让别人也看见 |

防刷屏的三个闸门（都在 `.env`）：`MAX_POSTS_PER_DAY=3`、`MIN_INTERVAL_MINUTES=90`、免打扰时段 `QUIET_START/QUIET_END`。命中任何一个都只记录不发送。

---

## 常驻运行

```bash
sudo cp deploy/x-digest.service /etc/systemd/system/
sudo nano /etc/systemd/system/x-digest.service   # 改 User / WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now x-digest
sudo journalctl -u x-digest -f
```

不需要 systemd 的话，`nohup npm run run &` 也能跑，但重启后要手动拉起。

---

## 它凭什么"觉得你会感兴趣"

两个输入：

1. **`interests.md`** —— 你的兴趣画像，直接改，改了下一轮生效。
2. **模型判断** —— 每轮把新推文（去掉转推和回复，最多 60 条）连同画像一起交给 DeepSeek，要求它只输出一个 JSON：

```json
{"picks":[{"id":"1234567890","score":85,"reason":"20字以内说清为什么值得他看"}]}
```

调优手感：

- 挑得太杂 → 在 `interests.md` 的负面清单里写得更狠，或者把 `MAX_PICKS` 降到 1。
- 挑得太少 → 画像写具体点（"推理优化"不如"vLLM/SGLang 的调度策略和 KV cache 优化"）。
- 完全不对味 → 先看 `data/state.json` 里的 `posts`，再对照 `npm run once` 的输出，通常两三轮就能调准。

---

## 顺带得到一个小接口

`npm run run` 会同时起一个只监听本机的 HTTP 服务（默认 `127.0.0.1:8788`），带上 `DIGEST_TOKEN` 就能用：

| 路由 | 用途 |
|---|---|
| `GET /health` | 活着吗、在刷谁、有没有发推权限（免 token） |
| `GET /timeline?handles=sama,karpathy&limit=20` | 直接拿原始时间线（JSON） |
| `GET /state` | 看过多少条、发过什么 |
| `GET /digest?dry=1` | 手动跑一轮（`dry=1` 只看不发，`force=1` 绕过频率限制） |
| `GET /whoami` | 验证发推凭据对应哪个账号 |

token 可以放在 `x-digest-token` 头里，也可以放在 `?token=` 查询参数里（为了能用 `web_fetch` 这种只能传 URL 的工具）。

```bash
curl -H "x-digest-token: $(grep DIGEST_TOKEN .env | cut -d= -f2)" \
     'http://127.0.0.1:8788/timeline?handles=sama&limit=5'
```

**别把端口裸奔到公网**。本机要用的话，开一条 SSH 隧道就够：

```bash
ssh -N -L 8788:127.0.0.1:8788 you@vps    # 然后本机访问 http://127.0.0.1:8788
```

想把 X 数据接进 DSH 里的 agent（比如问它"X 上今天有什么"，而不是等定时推送），把 `SKILL.md` 复制到你的用户 skill 目录即可：

```bash
mkdir -p ~/.dsh/skills
cp SKILL.md ~/.dsh/skills/x-digest.md      # Windows: %USERPROFILE%\.dsh\skills\
```

---

## 排错

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `一条都没抓到` | 机器出不去网，或 X 改了嵌入接口 | `npm run probe` 看具体报错；国内机器换海外 VPS |
| `X API 403` | 权限没勾 write，或 token 在改权限前生成 | 重新生成 Access Token |
| `X API 401` | key 抄错 / 有空格 | 重抄四个值 |
| `X API 429` | 发推额度或频率超了 | 降 `POLL_INTERVAL_MINUTES`，等一天 |
| `DeepSeek HTTP 401` | key 错了 | 换 key |
| 文案超长丢条目 | 理由太长 | `MAX_PICKS` 调小，或改 `compose.mjs` 的 `maxLength` |

---

## 成本与风控

- **X**：免费档 500 条发推/月；读时间线走的是公开嵌入接口，不消耗 API 额度。`MAX_POSTS_PER_DAY=3` 时一个月最多 90 条，远低于上限。
- **DeepSeek**：每轮 2–5k token（12 条新推文量级），按 `deepseek-chat` 价格一天 48 轮也就几分钱。
- **风控**：自动化发推本身允许，但"高频 @ 同一个人"容易被判定 spam。默认配置（一天 3 条、间隔 90 分钟、回复模式）是刻意保守的，**别关掉这些闸门**。真被限流就停一天再说。

---

## 互动层：评论 / 回评论 / 私信（cookie + 审核队列）

匿名接口只能读公开数据，而且经常被 429。要"能说话"，得用**小号的浏览器会话**。

### 1. 导出 cookie（只做一次）

1. 用**小号**登录 x.com（专门开一个，别用主号）
2. F12 → Application（应用）→ Cookies → `https://x.com`
3. 复制两个值：`auth_token`、`ct0`
4. 写进 `data/x-cookies.json`：

```json
{ "auth_token": "……", "ct0": "……" }
```

### 2. 验证

```bash
npm run session-probe
```

期望输出：

```
✓ 鉴权通过（DM 接口可用，说明 cookie 是登录态）
✓ 读时间线 @sama：15 条
✓ 读推文会话：5 条回复
```

探针**只读**，不会发出任何内容。

**这一步同时也是数据源**：有 cookie 时，服务优先用 GraphQL 按 `WATCH_HANDLES` 逐个账号读，不再走那个会被 429 的匿名接口。

### 2.5 X 的接口现状（2026-11 实测，改代码前必看）

| 接口 | 状态 |
|---|---|
| `/1.1/statuses/update.json`（老发推） | ❌ 已删除，返回 404 |
| `/1.1/account/verify_credentials.json` | ❌ 已删除 |
| `/1.1/statuses/home_timeline.json` | ⚠️ 200 但永远返回空 |
| `/1.1/dm/new2.json`（私信） | ✅ 存活 |
| `GraphQL CreateTweet`（发推/回复） | ✅ 可用 |
| `GraphQL UserTweets`（读账号时间线） | ✅ 可用 |
| `GraphQL TweetDetail`（读会话回复） | ✅ 可用 |
| `GraphQL UserByScreenName`（handle → id） | ✅ 可用 |

**queryId 会随 X 改版轮换**，轮换后的症状是 GraphQL 返回 404。换新值的办法写在 `src/xsession.mjs` 顶部注释里：下载 `abs.twimg.com/responsive-web/client-web/main.*.js`，搜 `operationName:"CreateTweet"` 拿到新的 `queryId`。

### 3. 写操作一律先落草稿

`REVIEW_REQUIRED=true`（默认）时，任何对外的写操作都不会自动发出：

| 动作 | 流程 |
|---|---|
| 回评论 / 发评论 | 生成草稿 → 你点「发」→ 才发 |
| 私信 | 同上；收件人必须在 `DM_WHITELIST` 里，绝不群发 |
| 发推 @你 | 仍走 `POST_MODE`（这条本来安全，可自动） |

三条闸门照常生效：每天回复上限 `REPLY_DAILY_LIMIT=5`、私信上限 `DM_DAILY_LIMIT=3`、免打扰时段。

### 4. 草稿接口

```bash
# 看待审
curl -H "x-digest-token: $TOKEN" http://127.0.0.1:8788/drafts?status=pending

# 通过（真的发出去）
curl -X POST -H "x-digest-token: $TOKEN" http://127.0.0.1:8788/drafts/<id>/approve

# 驳回
curl -X POST -H "x-digest-token: $TOKEN" -d '{"reason":"不想发"}' http://127.0.0.1:8788/drafts/<id>/reject
```

在 DSH 插件里对应 `x_drafts`（看待审）和 `x_review`（通过/驳回）两个工具。

### 风险，说清楚

- cookie 等同于小号的登录凭证：**只放在本机**，别提交到 git、别贴到聊天里。
- X 会检测自动化行为。审核队列 + 频率上限 + 只回主动互动的人，是把风险压到可控；**不是零风险**。
- cookie 会过期（改密码、异地登录、登出都会失效）。失效后 `session-probe` 会直接告诉你，重新导一次即可。

## 已知边界（别指望它做不到的事）

- 只读**公开**时间线，读不到私密账号、DM、关注列表。
- 嵌入接口是 X 的公开 widget 接口，**它改版就得改 `src/sources.mjs`**（目前有三种来源自动降级：syndication → cdn.syndication → 官方 API v2）。
- 不做发图、不做长文、不做 thread 串联。
- 只在 Node 24 + Linux 上验证过；Windows 能跑（`npm run once` 已在本机验证），只是常驻方式换成任务计划程序。
