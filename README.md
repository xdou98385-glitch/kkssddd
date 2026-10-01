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

## 微信读书

在 `.env` 里填 `WEREAD_API_KEY`（Agent Gateway 的 token，形如 `wrk-xxxx`）就会启用，不填则没有读书功能。只读：搜书、书架、阅读进度和统计、划线和想法、推荐、朋友在读。

- 给 Claude 的只有一个 `weread` 工具，接口表和易错字段规则（进度是百分比、时长是秒、星级换算等）写在 `src/persona.ts` 的 `WEREAD_GUIDE` 里。
- 网关升级要求（`upgrade_info`）和 401 都会原样告诉你，不会反复重试。
- ⚙ 设置里有一行连接状态，启动日志里也有 `weread:` 一行。
- token 只放服务器的 `.env`，不要提交到 git。

## 主动消息与通知

网页推送（Web Push）：服务器在你没打开网页时也能给手机弹通知。**iPhone 必须先「添加到主屏幕」，再从主屏幕上的图标打开**，在 ⚙ 设置里点「开启本机通知」。

- 默认关闭。在设置里勾选「允许它主动找我」，设安静时段和每天最多几条。
- 每隔一段时间（`PROACTIVE_EVERY_MIN`，默认 90 分钟）它会「想一次」：有话想说就写进聊天并推送，没话就不发。
- 不会打扰你的限制：安静时段不发；上一条主动消息你还没回就不再发；刚聊过 45 分钟内不发；两条主动消息至少隔 3 小时；每天有上限。
- 「现在试一条」会跳过所有限制，让它马上写一条，用来测试。
- VAPID 密钥第一次用时自动生成并存在数据库里，不用配置。

## 设备活动（快捷指令）

网页看不到你手机上别的 app，所以用 iPhone 的「快捷指令」自动化往服务器汇报事件，Claude 通过 `device_activity` 工具查看。iOS 拿不到完整的屏幕使用时间，只能记录你选定的这几类事件。

1. 在 `.env` 里设 `DEVICE_TOKEN`（`openssl rand -base64 24` 生成），重启。
2. 快捷指令 → 自动化 → 新建个人自动化，触发条件选一个（打开某个 app / 专注模式 / 开始充电 / 闹钟停止 …），动作选「获取 URL 内容」：
   - URL：`https://你的地址/api/events`
   - 方法：`POST`
   - 请求头：`Authorization` = `Bearer 你的DEVICE_TOKEN`；`Content-Type` = `application/json`
   - 请求体选 JSON，加文本字段 `kind`（见下表），按需加 `app`、`detail`
   - 把自动化的「运行前询问」关掉
3. 事件类型：`app_open`（app 填 app 名，每个 app 单独做一条自动化）、`app_close`、`focus_on`/`focus_off`、`charging_on`/`charging_off`（detail 可填电量）、`wake`（起床）、`arrive`/`leave`（app 或 detail 填地点）。别的 `kind` 也能传，Claude 会照字面看。
4. ⚙ 设置里会显示最近一条事件是多久以前，用来确认通了。

**更简单的 GET 写法（推荐，POST 总出问题时用）**：「获取 URL 内容」的方法保持默认的 GET，不设请求头、不设请求体，整个请求只有一个网址：

```
https://你的地址/api/events?token=你的DEVICE_TOKEN&kind=charging_on
https://你的地址/api/events?token=你的DEVICE_TOKEN&kind=app_open&app=微信读书
```

口令里如果有 `+` `/` `=` 这些符号，要写成 `%2B` `%2F` `%3D`（或者换一个只含字母数字的口令：`openssl rand -hex 20`）。口令放在网址里，所以别把这个网址分享出去；服务器日志只记路径，不记问号后面的内容。

排查连接问题：服务器会在日志里记每个 `/api/` 请求（方法、路径、状态码、耗时），`docker compose logs --tail 20` 就能看到手机的请求有没有到。格式不对的请求会记一行 `clientError`。

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
src/weread.ts   微信读书网关调用
src/push.ts     网页推送（VAPID、发送、清理失效订阅）
src/proactive.ts 主动消息（心跳、限制、定时）
src/device.ts   设备事件记录与摘要
public/sw.js    Service Worker（收推送、点通知回到应用）
src/tools.ts    给 Claude 用的工具（搜索/保存记忆）
src/db.ts       SQLite（对话、消息、设置）
src/context.ts  上下文管理（滚动摘要、图片窗口）
src/uploads.ts  图片存取
public/         前端（index.html / login.html / app.js / style.css / PWA 清单）
```
