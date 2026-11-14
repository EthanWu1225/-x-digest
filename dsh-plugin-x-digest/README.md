# dsh-plugin-x-digest

把 [x-digest](../x-digest/README.md) 服务接进 DeepSeek Harness（DSH）：**一个设置页 + 五个工具**。

它不自己抓 X，只是把服务的 HTTP 接口包一层。

## 装法

```powershell
cd .\dsh-plugin-x-digest
.\deploy\install-dsh-plugin.ps1
```

脚本做两件事：把插件复制到 `<DSH_HOME>\profiles\desktop\node_modules\dsh-plugin-x-digest`，
并在 profile 的 `cordis.patch.yml` 里追加一个 insert 块（已有就跳过）。

装完**重启 DSH**，然后在 **设置 → X 速览** 里就能看到。

卸载：

```powershell
.\deploy\install-dsh-plugin.ps1 -Rollback
```

> 客户端代码（`lib/client.js`）改动会热更新；**宿主代码**（`lib/index.js`、`host-routes.mjs`）
> 必须重启 DSH 才生效——这是最容易踩的坑。

## 设置页

六个标签，一页一件事：

| 标签 | 能改什么 |
|---|---|
| **摘要** | 内容来源（关注账号/关键词搜索/首页推荐流）、分区多选、关键词、排序、赞数门槛、@ 谁、发推模式、挑几条 |
| **监听** | @ 回复开关、检查频率、白名单、立即检查一次 |
| **看图** | 视觉模型状态、摘要时是否看图、每轮看几张、视频开关、每轮看几条、抽几帧 |
| **记录** | 刷过的推文列表（已发/干跑/含敏感词/已拦截）+ 状态计数 |
| **风格** | 说话风格提示词（写 `prompts/mention-reply.md`） |
| **凭据** | OAuth2 Client ID/Secret、cookie（auth_token/ct0）、授权链接与授权码 |

几个行为细节：

- 勾选分区会**立即保存**（刷新不丢），并把关键词合并进输入框
- 勾「政治」分区会自动关掉政治内容过滤
- 状态栏显示的是**当前来源**：`在刷：科技/游戏（6 组关键词）`

## 工具

在对话里直接说就行，比如「跑一轮看看」。

| 工具 | 作用 |
|---|---|
| `x_timeline` | 读时间线 / 某人的推文 |
| `x_digest_now` | 立刻跑一轮筛选（默认只出文案不发送） |
| `x_digest_status` | 服务状态、额度、下次窗口 |
| `x_drafts` | 看审核队列里的草稿 |
| `x_review` | 批准或驳回某条草稿 |

## 连不上服务时

插件默认连 `http://127.0.0.1:8788`。如果服务在别的机器上：

1. **SSH 隧道**（推荐）
   ```bash
   ssh -N -L 8788:127.0.0.1:8788 you@vps
   ```
2. 或者把 `baseUrl` 指到能访问的地址（反代 + HTTPS），
   但**别把没有鉴权的接口裸奔在公网**。

配置方式见 profile 的 `cordis.patch.yml` 里 `x-digest` 块的 `config.baseUrl`。

## 开发

```powershell
node test/plugin.test.mjs      # 10 个断言
```

改完先跑测试，再用 `install-dsh-plugin.ps1` 复制过去。
