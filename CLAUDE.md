# kkssddd 项目交接说明（给下一个会话的 Claude）

这是小月（项目主人）给自己做的 Claude 陪伴类聊天网页，部署在她自己的 Vultr 服务器上。她刚入门编程，所有东西都是你来写，她负责试用、截图、反馈。

## 和她协作的约定
- 用中文，简洁直白，不说教，不要在句子开头加"哈"。她平时的称呼偏好是小月/新月/小k/Kay。
- 她不熟终端：给她的命令要能整段复制，一步一步来，每步说明"成功长什么样、失败怎么办"。
- **绝不要她把 token / API key / 口令贴给你**（Memos token、WEREAD_API_KEY、DEVICE_TOKEN、ANTHROPIC_API_KEY）。教她写进服务器 `.env`。她截图里露过 DEVICE_TOKEN 一次，已建议轮换（`openssl rand -hex 20`），不确定她做了没有。
- 没问她之前别建 PR。分支：`claude/festive-dijkstra-e4bjdy`（还没合并到主分支，新会话从这个分支继续）。
- 提交信息末尾要带系统给的 Co-Authored-By / Claude-Session 行。

## 技术栈与结构
Node ≥22.18（直接跑 .ts，不用构建）+ Hono + SQLite（`node:sqlite`）+ 纯 HTML/JS 前端（PWA）。一个 Docker 容器，`network_mode: host`，只监听 127.0.0.1:3000，靠 Tailscale Funnel 对外：`https://kshin624.tailf782fd.ts.net`。

```
src/server.ts     路由 + SSE 流式；访问日志（只记路径，不记问号后参数）
src/claude.ts     调 Claude（模型表、流式、工具循环、缓存、fallback、摘要）
src/context.ts    系统提示词拼装 buildSystem、历史窗口 buildHistory、滚动摘要、系统记录 TOOL_MARK
src/persona.ts    默认人设（来自她在 claude.ai 的偏好）+ 各功能使用说明（HONESTY/GAME/WEREAD/DEVICE/MEMORY_GUIDE）
src/tools.ts      给 Claude 的工具：sudoku_*、search/save_memory、weread、device_activity
src/memos.ts      Memos 记忆（/api/v1/memos，Bearer token，标签 #claude 是它写的，#core 每次对话自动注入）
src/weread.ts     微信读书网关（只读，参数平铺，skill_version 1.0.4，401/upgrade_info 照实报告）
src/sudoku.ts     数独出题（唯一解）、提示（唯一候选数/唯一位置）
src/push.ts       Web Push（VAPID 自动生成存库，sub 默认用站点 https 地址）
src/proactive.ts  主动消息心跳（安静时段/每日上限/未回复不再发/刚聊过不发/间隔 3 小时）
src/tts.ts        文字转语音（ElevenLabs）：按文本缓存到 data/tts/，每月字符上限，GET /api/tts/:消息id（支持 Range，iPhone 才肯播）
src/device.ts     设备事件（快捷指令上报，GET 和 POST 都支持，token 在 ?token= 或 Authorization）
src/auth.ts       登录（签名 cookie + 防暴力）；/api/events 和 /sw.js 等少数路径公开
public/           index.html / app.js / style.css（磨砂玻璃单色风）/ login.html / sw.js / hero.png（银箔月相）
```

## .env 变量（只写名字）
ANTHROPIC_API_KEY, APP_PASSWORD, MEMOS_URL, MEMOS_TOKEN, WEREAD_API_KEY, DEVICE_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, TTS_MODEL(默认 eleven_flash_v2_5), TTS_MAX_CHARS(600), TTS_MONTHLY_CHARS(20000), PROACTIVE_EVERY_MIN(默认90), PUSH_CONTACT(可空), PORT/DB_PATH。空值要用 `||` 而不是 `??` 判断（compose 的 env_file 会把空行变成空字符串）。

## 部署
服务器上：`cd ~/kkssddd && git pull && docker compose up -d --build`。数据在 `./data/`（chat.db + uploads）。设置页(⚙)里有 Memos/读书/设备/通知的连接状态行，启动日志有 `memory:`/`weread:`/`device events:` 行，排查先看这些。

## 关键设计（改之前先想清楚）
- 只有一条持续对话；最近消息原文，超过 60 条时前面压成 Haiku 写的滚动摘要，只留 30 条（批量折叠才能保住提示词缓存）。界面历史完整。
- 图片发送前浏览器压缩到长边 1568 的 JPEG，只有最近 10 条消息里的图会真发给模型。
- **防编造**：模型老是不调工具就说"我看了棋盘/翻了笔记"。已修：代码记录真实调用的工具存 `messages.tools`，回放历史时给助手回复加 `[系统记录：这条回复调用了工具 …]`，模型自己写的这种行会被 `stripToolMarks` 删掉；HONESTY_GUIDE 写了规则；Sonnet effort 改成 high。**这个修复还没在她真机上验证**，她打算清空聊天重新开始后观察。
- 工具调用的小字：当次显示带参数的，刷新后按 `messages.tools` 里的工具名显示通用小字（`app.js` 的 TOOL_LABELS），参数没存。
- 主动消息每次心跳都会调 Claude（花钱），默认关闭，她在设置里勾选开启；强制测试按钮「现在试一条」跳过所有限制。
- iPhone 推送：必须"添加到主屏幕"后从图标打开；已在她真机上跑通。

## 环境里踩过的坑
- 沙箱出口策略连不上 i.weread.qq.com、usememos.com、别的 GitHub 仓库；微信读书和 Memos 只能用仿造服务器测，真实字段以她真机为准。
- Bash 工具偶尔因安全检查返回"无结论"，重试一次；`pkill -f "src/server.ts"` 会把自己的 shell 杀掉，别这么写。
- 测试脚本（仿造的 Claude/Memos/微信读书/推送服务、Playwright 截图）放在会话的 scratchpad 里，没入库。想复测的话重新写，思路：设 `ANTHROPIC_BASE_URL=http://localhost:9999` 指向本地假 Claude，`DB_PATH` 指向临时文件。
- 没装中文衬线字体，截图里衬线是回退字体，真机（iOS 宋体）才对。
- Hono 自带 logger 会把问号后的参数（含设备口令）打进日志，所以用了自己的访问日志。

- 语音：每条助手消息时间旁有喇叭按钮，点了才生成（不自动念）。她的 ElevenLabs 声音是英文的（中文她觉得尬），Flash 模型能念中文但带口音，想换音质改 TTS_MODEL。接下来她想要：①模仿通话 ②微播客（Claude 写短稿再念，复用 tts.ts）；通话需要语音识别，iPhone PWA 里最脆弱，放最后。
- **聊天记录曾每次更新都丢**：她服务器 `.env` 里有 `DB_PATH=data/chat.db`（是照着旧的 `.env.example` 抄的，现已改成注释），盖掉了 Dockerfile 的 `/data/chat.db`，库落在容器内部。已在 docker-compose.yml 的 environment 里写死 `DB_PATH: /data/chat.db`（environment 优先于 env_file），并帮她把当时的库拷到了 `./data/`。之后 `./data/chat.db` 应当持续存在。

## 待办 / 她提过的想法
- 确认她已轮换 DEVICE_TOKEN（charging_off 快捷指令她已补）。
- 观察主动消息的花销和分寸（太贵调大 PROACTIVE_EVERY_MIN，太频繁调每天上限）。
- 验证防编造修复在真机上是否有效；如果还会编，再想办法（比如把工具结果也存进历史、必要时强制先调工具）。
- 语音（她看的 Voicebox 在 Mac M4 上调不出满意效果，先放着；可选 Kokoro 或云端 TTS）。
- 小红书 / X 接入（最脆弱，放最后）；更多益智小游戏；Minecraft（需要更大的服务器，她最近不玩大游戏）。
- 把外观里"招牌元素"（月相）用到更多地方。
- 是否要把分支合并到主分支（她没要求前不要建 PR）。
