# kkssddd

自用的 Claude 聊天网页（可装到 iPhone 主屏幕）。后端 Node + Hono，数据存 SQLite，前端纯 HTML/JS，没有构建步骤。

现在有的功能：多对话、流式回复、Markdown 渲染、切换模型（Sonnet / Opus / Haiku）、全局系统提示词、中途停止、手机/电脑自适应。

## 本地跑起来

需要 Node ≥ 22.18。

```bash
npm install
cp .env.example .env      # 然后编辑 .env，填 ANTHROPIC_API_KEY
node --env-file=.env src/server.ts
```

打开 http://localhost:3000 。

## 部署到 Vultr（走 Tailscale 私网）

1. 服务器和 iPhone 都装 Tailscale 并登录同一个账号。
2. 服务器装 Docker，然后：
   ```bash
   git clone <这个仓库> && cd kkssddd
   cp .env.example .env && nano .env     # 填 ANTHROPIC_API_KEY
   docker compose up -d --build
   ```
   容器只监听服务器本机的 3000 端口，公网访问不到。
3. 用 Tailscale 把它以 HTTPS 发布到私网：
   ```bash
   tailscale serve --bg 3000
   ```
   它会给你一个 `https://<机器名>.<tailnet>.ts.net` 的地址，只有你 tailnet 里的设备能打开。
4. iPhone 开着 Tailscale，用 Safari 打开这个地址 → 分享 → 添加到主屏幕。

更新：`git pull && docker compose up -d --build`。数据在 `./data/chat.db`，备份直接复制这个文件。

## 注意

- API key 只放在服务器的 `.env` 里，`.env` 已被 git 忽略，别提交。
- 去 Anthropic 后台设置月度花费上限。
- 想再加一层密码：在 `.env` 里设 `APP_PASSWORD`（用户名默认 `me`）。
- 不要用 `tailscale funnel`，那会把站点暴露到公网。

## 结构

```
src/server.ts   路由 + SSE 流式接口
src/claude.ts   调 Claude（模型列表、流式、缓存、拒绝回退）
src/db.ts       SQLite（对话、消息、设置）
public/         前端（index.html / app.js / style.css / PWA 清单）
```
