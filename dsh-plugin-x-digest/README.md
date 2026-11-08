# dsh-plugin-x-digest

把 VPS 上的 [x-digest](../x-digest/README.md) 接进 DeepSeek Harness（DSH）对话：

- `x_timeline` —— 读时间线，回答"X 上今天有什么""某人在说什么"
- `x_digest_now` —— 让服务立刻跑一轮筛选（默认 dry，只出文案不发送）
- `x_digest_status` —— 排查"为什么没收到推送"

它**不自己抓 X**，只是把已经跑在 VPS 上的那个服务的 HTTP 接口包成工具。所以前提没变：VPS 要能连 x.com。

---

## 装法

```powershell
cd .\dsh-plugin-x-digest
.\deploy\install-dsh-plugin.ps1 -Token '你的 DIGEST_TOKEN'
# 然后重启 DSH
```

脚本做三件事：复制到 `<DSH_HOME>\profiles\desktop\node_modules\`、在 profile 的 `cordis.patch.yml` 里追加一个 insert 块（原文件先备份成 `.x-digest.bak`）、打印重启提醒。

不想要了：

```powershell
.\deploy\install-dsh-plugin.ps1 -Rollback
```

装完在对话里问一句「x_digest_status 看看服务状态」，工具能回答就说明通了。

### 没有 SSH 隧道的话

插件默认连 `http://127.0.0.1:8788`。服务在 VPS 上，所以本机要先开隧道：

```bash
ssh -N -L 8788:127.0.0.1:8788 you@vps
```

不想每次开隧道，就把 `baseUrl` 指向一个能访问的地址（反代 + HTTPS 更稳），但**别把带 token 的接口裸奔在公网**。

---

## 配置

三种写法，优先级从高到低：

1. patch 里的 `config:`（安装脚本写入的那个块）
2. 环境变量 `X_DIGEST_URL` / `X_DIGEST_TOKEN` / `X_DIGEST_HANDLES`
3. `%USERPROFILE%\.dsh\x-digest.json`：

```json
{ "baseUrl": "http://127.0.0.1:8788", "token": "abc123", "defaultHandles": "sama,karpathy" }
```

sidecar 文件的好处是改完**不用重启 DSH**（每次调用现读）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8788` | 没写协议会自动补 `http://` |
| `token` | 空 | 要和 VPS 上 `.env` 的 `DIGEST_TOKEN` 一致 |
| `defaultHandles` | 空 | 逗号分隔；留空时用服务端的 `WATCH_HANDLES` |
| `timeoutMs` | 15000 | 单次请求超时 |

---

## 设置页（DSH 设置 → X 速览）

插件带客户端半侧，会在 DSH 设置左侧加一页「X 速览」，交互由三部分支撑：

| 层 | 文件 | 作用 |
|---|---|---|
| 客户端 | `lib/client.js` | 自注册脚本（`window.__ModuleLoader__.load`），注册 `settings.section` 槽位 |
| 宿主 | `lib/host-routes.mjs` | 在宿主 webServer 上挂 `/api/x-digest/*`，转发给本地服务 |
| 服务 | `x-digest/src/server.mjs` | `GET/POST /config`，改动写回服务目录的 `.env` |

页面上能做的事：

- 看状态：服务在线/离线、在刷谁、已记录多少条
- 改配置：关注账号、@ 谁、发推模式（off / reply / mention）、每次挑几条
- 「现在跑一轮（干跑）」：立刻跑一轮并把挑中的结果列在页面里
- 保存会**直接写服务的 `.env`** 并同步内存，不用重启服务

⚠️ 两点限制：

- **服务地址和 token 不在这页改**——它们在 `%USERPROFILE%\.dsh\x-digest.json`（改了即时生效，但要重启 DSH 才会重新读一次）
- 客户端 bundle 在页面启动时装配，**装完/改完必须重启 DSH** 才会出现这一页

## 为什么这个插件不 import 任何 DSH 包


`defineTool()` 编译完也只是个普通对象，而 `tools.register()` 运行时只检查 `output.schema`（受支持的 JSON Schema 子集）和 `output.render` 是函数。所以这里直接手写定义：

- 插件对 `@deepseek-ai/*` **零依赖**，DSH 升级、换安装方式（asar / npm / mise）、profile 里解析到哪个版本，都不会让插件在 import 阶段炸掉；
- 代价是没有参数自动校验，所以每个 `execute` 自己做类型收敛，`output.schema` 用宿主自己的 `assertSupportedJsonSchema()` 在测试里验过。

同理，`apply()` 整体包了 try/catch：配置写错、地址填错，都只是这三个工具缺席 + 日志里一条 error，**不会拖垮 DSH 启动**。

---

## 测试

```bash
node test/plugin.test.mjs
```

会把插件挂进**真实的 Cordis 上下文**（用假 tools 注册表），配一个假 HTTP 服务，验证：工具注册、时间线整形、dry 透传、离线降级、配置优先级、以及手写 schema 能不能通过宿主的校验器。

`test/hooks.mjs` 是给工作区用的模块解析钩子（把 `@deepseek-ai/*` 指到本机 profile 的依赖），**生产安装不需要它**。

---

## 已知边界

- 只是数据通道：抓取、筛选、发推全在 VPS 上，插件停了推送照常。
- `x_digest_now` 传 `dry: false` 会**真的发推**，模型只有在用户明确要求时才该这么做。
- 没有设置面板（那需要客户端半侧 + 构建产物）；配置走 patch / sidecar。
- 服务没起、隧道没开时，`x_digest_status` 会返回 `online: false` 和具体错误，而不是抛异常。
