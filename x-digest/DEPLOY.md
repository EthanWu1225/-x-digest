# 部署方式

四种形态，按「跑在哪」区分。选哪种主要看**发推走哪条通道**（见文末对照表）。

| 形态 | 适合 | 发推通道 | 已验证 |
|---|---|---|---|
| A. Windows 本机 + 计划任务 | 个人电脑、7×12 使用 | 浏览器（无需额度） | ✅ 当前在用 |
| B. Windows 本机 + 系统服务 | 同上，但不想登录才启动 | 浏览器 | ⬜ 未测 |
| C. Linux VPS + systemd | 7×24 | API（需额度）或 Chromium | ⬜ 未测 |
| D. Docker | 7×24、迁移方便 | API（推荐） | ⬜ 未测 |

## 共同前置

| 需要 | 说明 |
|---|---|
| Node.js 20+（A/B/C） | 只有 Docker 不需要 |
| DeepSeek API key | 判断 + 看图 + 看视频全靠它，一天几分钱 |
| X 小号 cookie | `auth_token` + `ct0`，读时间线/通知必须 |
| 能访问 x.com | 国内机器需要代理 |
| （可选）X API 额度 | 有额度就不需要浏览器，$5 起 |

## A. Windows 本机（当前方式）

```powershell
cd x-digest
copy .env.example .env          # 填 key 和 cookie
npm i
npm run session-probe           # 验证 cookie
npm run browser:login           # 首次登录小号（会弹窗口，扫码/输密码）
npm run once                    # 干跑一轮，不发东西
```

装成开机自启（计划任务，不需要管理员）：

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c \"$PWD\start-service.cmd\"" -WorkingDirectory $PWD
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "x-digest" -Action $action -Trigger $trigger -Description "X 速览"
```

管理：

```powershell
Start-ScheduledTask  -TaskName x-digest
Stop-ScheduledTask   -TaskName x-digest
Get-ScheduledTaskInfo -TaskName x-digest
Get-Content data\x-digest.log -Tail 20
```

**限制**：电脑关机/睡眠就停；注销后不跑。

## B. Windows 系统服务（nssm）

适合「开机即跑、不需要登录桌面」的场景。

```powershell
choco install nssm                      # 或从 nssm.cc 下载
nssm install x-digest "C:\Windows\System32\cmd.exe" "/c D:\path\x-digest\start-service.cmd"
nssm set x-digest AppDirectory D:\path\x-digest
nssm set x-digest Start SERVICE_AUTO_START
nssm start x-digest
```

⚠️ 浏览器通道在 Session 0（无桌面）里**可能无法启动**，需要设 `BROWSER_HEADLESS=true`（默认就是）。

## C. Linux VPS + systemd

```bash
# 1. 依赖
apt update && apt install -y nodejs npm chromium ffmpeg fonts-noto-cjk

# 2. 部署
git clone <你的仓库> ~/x-digest && cd ~/x-digest/x-digest
npm i --omit=dev

# 3. 配置
cp .env.example .env && nano .env        # 填 key、cookie
# 让浏览器找到 chromium：
echo 'BROWSER_EXECUTABLE=/usr/bin/chromium' >> .env

# 4. 验证
node src/cli.mjs --session-probe

# 5. 装服务
sudo cp deploy/x-digest.service /etc/systemd/system/
sudo nano /etc/systemd/system/x-digest.service   # 改 User / WorkingDirectory / node 路径
sudo systemctl daemon-reload && sudo systemctl enable --now x-digest
journalctl -u x-digest -f
```

**浏览器登录这一步在 VPS 上是难点**：没有桌面，`--browser-login` 弹不出窗口。
可选做法：装 `xvfb-run` 后跑 `xvfb-run -a node src/cli.mjs --browser-login`，
但验证码/扫码没法操作——**所以 VPS 上更建议用 API 额度发推**。

## D. Docker

```bash
cd x-digest
cp .env.example .env        # 填 key 和 cookie
docker compose up -d --build
docker compose logs -f
```

数据目录挂载在 `./data`，容器重建不丢登录态和记忆。

**Docker 里别用浏览器通道**：容器内没法扫码登录。建议配 X API 额度后设：

```ini
POST_TRANSPORT=api
```

## 发推通道对照（决定部署形态）

| 你的情况 | 怎么设 | 能部署到 |
|---|---|---|
| 有 API 额度 | `POST_TRANSPORT=api` | 任意平台/Docker，最稳 |
| 没有额度 | `POST_TRANSPORT=auto`（默认） | **必须**有图形界面或本机 Edge |

`auto` 模式会先试 API，失败（402/401）自动切浏览器。

## 迁移清单

换机器时**必须带走**这些（都在 `data/` 和根目录）：

```
.env                        配置（key、凭据）
data/x-cookies.json         读 X 用
data/x-tokens.json          API 发推用（有额度才有意义）
data/state.json             已看过哪些推（避免重复）
data/history.json           刷过的推文记录
data/mentions.json          回过哪些 @
interests.md                兴趣画像
prompts/mention-reply.md    说话风格
```

⚠️ **`data/browser-profile/` 不要跨系统复制**：Windows 的 cookie 用 DPAPI 加密，
Linux 上解不开。换系统要重新登录一次。

## 常见问题

**Q: 视频识别在新机器上失败？**
A: 依赖 `ffmpeg-static`（`npm i` 时按平台自动下载）。若报「没能抽到帧」，
检查临时目录是否可写——代码把临时文件放在 `data/video-tmp/`，不用系统 `/tmp`。

**Q: 端口被占用？**
A: 默认 `127.0.0.1:8788`，改 `.env` 里的 `PORT`。

**Q: 国内机器连不上 x.com？**
A: 设 `HTTPS_PROXY`（并保留 `NODE_USE_ENV_PROXY=1`）。DeepSeek 和百炼的域名要放进
`NO_PROXY`，否则会被代理绕远导致偶发失败。
