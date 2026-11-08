---
name: x-digest
description: 查询 VPS 上 x-digest 服务抓到的 X（推特）时间线数据，用于回答"X 上今天有什么""某人在说什么"这类问题。不在需要推送时使用。
whenToUse: 用户问 X/推特上的内容、某个账号最近说了什么、某个话题在 X 上的讨论，而本机连不上 x.com 时。
---

# x-digest：从 VPS 读 X 数据

本机通常直连不了 x.com（TLS 被重置/超时），但 VPS 上的 `x-digest` 能。它已经把公开时间线抓好了，直接查它。

## 前提

服务地址和 token 由用户提供，形如：

```
BASE=http://127.0.0.1:8788        # 通常是 SSH 隧道过来的
TOKEN=xxxxxxxx
```

如果 `GET {BASE}/health` 失败，先确认隧道是否开着：`ssh -N -L 8788:127.0.0.1:8788 you@vps`。

## 三条命令

**1. 拿时间线（最常用）**

```
{BASE}/timeline?handles=sama,karpathy&limit=10&token={TOKEN}
```

返回 JSON：`items[]` 每项有 `id / handle / text / createdAt / likes / reposts / url`，`errors[]` 是抓失败的账号。默认抓 `.env` 里 `WATCH_HANDLES` 的账号，传 `handles` 可临时覆盖。

**2. 确认活在**（不需要 token）

```
{BASE}/health
```

**3. 手动触发一轮筛选**（只在用户明确说"现在就帮我筛一轮"时用）

```
{BASE}/digest?dry=1&token={TOKEN}
```

`dry=1` 只看不发；**不要**在用户没要求时用 `dry=0`，那会真的用他的账号发推。

## 回答方式

- 优先按"这条对用户有什么用"组织，不要逐条复述原文。
- 每条都给 `url`，让用户能点开看。
- 时间统一换算成用户本地时区的人话（"3 小时前"），不要甩 ISO 时间戳。
- 抓取有 `errors[]` 时如实说哪些账号抓失败了，不要假装数据完整。

## 不要做的事

- 不要自己编推文内容：拿不到就直说拿不到。
- 不要把 token 打进最终回答里。
- 不要调用任何写接口（`/digest?dry=0`、`/whoami` 以外的 POST）。
