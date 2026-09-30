# kkssddd

自用的 Claude 聊天网页（可装到 iPhone 主屏幕）。后端 Node + Hono，数据存 SQLite，前端纯 HTML/JS，没有构建步骤。

现在有的功能：一条一直聊下去的对话（上滑翻历史）、发图片、流式回复、Markdown 渲染、切换模型（Sonnet / Opus / Haiku）、系统提示词、Memos 记忆、中途停止、手机/电脑自适应。

数独：头部左上角的按钮展开棋盘（简单/中等/困难，保证唯一解；简单和中等只靠基础技巧就能解完）。盘面存在服务器上，刷新不丢。Claude 有三个工具：看棋盘、算提示、替你落子，面板里的「要提示」「你来下一步」会自动替你问它；做完一盘也会自动告诉它。它落的子在棋盘上是灰色斜体。

长对话怎么处理：最近的消息原文都带给模型；超过 60 条时，把最早的压成一份滚动摘要（用 Haiku，后台进行），只保留最近 30 条原文。界面上的历史不受影响，数据库里也全都保留。重要的事另外靠 Memos 长期记住。

图片：发送前在浏览器里压缩到长边 1568px 的 JPEG，存在 `data/uploads/`（跟数据库一起备份）。只有最近 10 条消息里的图片会真的发给模型，更早的换成文字占位以省钱。

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

更新：`git pull && docker compose up -d --build`。数据在 `./data/`（`chat.db` 和 `uploads/`），备份直接复制这个目录。

## 记忆（Memos）

在 `.env` 里填 `MEMOS_URL` 和 `MEMOS_TOKEN`（Memos 里 设置 → 我的账号 → Access Tokens）就会启用，不填则没有记忆功能，其他照常用。

- Claude 会自己判断什么时候翻记忆、什么时候存记忆，聊天里会有一行小字提示（🔎 / 📝）。
- 它存的笔记会带 `#claude` 标签，方便你在 Memos 里区分，也可以随时编辑或删除。
- 你在 Memos 里给笔记加上 `#core` 标签，那条就会在每次对话开头自动读进去，适合放最重要的长期信息。
- 容器用宿主机网络，所以 Memos 地址填服务器本机的，比如 `http://127.0.0.1:5230`。

验证 token 和地址对不对（在服务器上）：

```bash
curl -s -H "Authorization: Bearer 你的token" "http://127.0.0.1:5230/api/v1/memos?pageSize=1"
```

能返回笔记的 JSON 就是通的。

## 放到公网（Tailscale Funnel）

不想每次开 Tailscale 的话，用 Funnel 把同一个地址开放到公网：

```bash
# 1. 先在 .env 里设好 APP_PASSWORD（长随机串），然后
docker compose up -d
# 2. 再开 Funnel（先用 `tailscale serve reset` 清掉旧的 serve 配置也行）
sudo tailscale funnel --bg 3000
tailscale funnel status
```

第一次可能要按提示去 Tailscale 后台授权 Funnel。之后任何设备用那个 `https://….ts.net` 地址都能打开，输密码登录（30 天免登录）。

登录带失败次数限制：同一 IP 连错 5 次锁 15 分钟，全站一小时连错 40 次也会锁 15 分钟。

关掉公网：`sudo tailscale funnel --bg off 3000`（或 `tailscale funnel reset`），恢复成只有你的设备能访问：`sudo tailscale serve --bg 3000`。

## 注意

- API key 只放在服务器的 `.env` 里，`.env` 已被 git 忽略，别提交。
- 去 Anthropic 后台设置月度花费上限。
- 放公网时 `APP_PASSWORD` 必须设，而且要够长。

## 结构

```
src/server.ts   路由 + SSE 流式接口
src/auth.ts     登录（签名 cookie + 防暴力猜密码）
src/claude.ts   调 Claude（模型列表、流式、工具循环、缓存、拒绝回退）
src/persona.ts  默认人设
src/memos.ts    Memos 读写
src/sudoku.ts   数独出题、校验、提示
src/tools.ts    给 Claude 用的工具（搜索/保存记忆）
src/db.ts       SQLite（对话、消息、设置）
src/context.ts  上下文管理（滚动摘要、图片窗口）
src/uploads.ts  图片存取
public/         前端（index.html / login.html / app.js / style.css / PWA 清单）
```
