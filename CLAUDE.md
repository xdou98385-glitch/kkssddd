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
src/config.ts     设置页「连接」：MEMOS_URL/MEMOS_TOKEN/WEREAD_API_KEY/DEVICE_TOKEN/ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID 存在 settings 表（键 cfg:名字），优先于 .env，清空退回 .env；各模块用 cfg() 现读，`memosEnabled` 等是 export let 实时绑定，改完 notifyConfigChanged() 立即生效不用重启；getTools() 每次重算。密钥只写不读（只有 DEVICE_TOKEN 可点「查看」）。ANTHROPIC_API_KEY 和 APP_PASSWORD 故意仍只在 .env。
src/tools.ts      给 Claude 的工具：sudoku_*、search/save_memory、weread、device_activity
src/memos.ts      Memos 记忆（/api/v1/memos，Bearer token，标签 #claude 是它写的，#core 每次对话自动注入）
src/weread.ts     微信读书网关（只读，参数平铺，skill_version 1.0.4，401/upgrade_info 照实报告）
src/sudoku.ts     数独出题（唯一解）、提示（唯一候选数/唯一位置）
src/push.ts       Web Push（VAPID 自动生成存库，sub 默认用站点 https 地址）
src/proactive.ts  主动消息心跳（安静时段/每日上限/未回复不再发/刚聊过不发/间隔 3 小时）
src/tts.ts        文字转语音（ElevenLabs）：按文本缓存到 data/tts/，每月字符上限，GET /api/tts/:消息id（支持 Range，iPhone 才肯播）
src/podcast.ts    电台节目：设置外的「电台」页点「来一期」→ 后台让 Claude 一次写出 <title>/<title_en>/<zh>/<en>（中文稿 600–900 字 + 同内容的英语口语稿），存 episodes 表（不进聊天记录），英语稿按段落分块、带前后文（previous_text/next_text）用 podcastVoice 配音再拼起来；status: writing→voicing→ready/failed，前端轮询 GET /api/podcasts，音频走 GET /api/podcast/:id/audio（Range）
src/xhs.ts        小红书（只读）：调旁边的 xpzouying/xiaohongshu-mcp 容器（docker-compose 里 xhs 服务，profile=social，只绑 127.0.0.1:18060，登录态在 ./data/xhs），工具 xhs_search/xhs_feed/xhs_note/xhs_me；请求排队、间隔 XHS_GAP_SECONDS(4)、每天 XHS_DAILY_CALLS(80) 次上限。她扫码登录（设置页「小红书」→登录二维码），应用不碰 cookie。写操作（点赞/评论/发帖）故意没接。**她服务器上其实已有一个原生的 systemd 服务 xhs-mcp（/root/xiaohongshu-mcp-linux-amd64，监听 18060，没口令，靠 ufw 只放行 22 挡外网），所以不用 docker-compose 里的 xhs 服务（那是 profile=social 的备用，她没启用）；设置里地址填 http://127.0.0.1:18060。** 登录二维码：容器那边每要一次就开新浏览器并作废上一张，所以 xhsQrcode 单飞+200 秒内复用，前端只在过期后才重新要，并每 6 秒自动查是否扫成功。没法在沙箱里连真小红书，只用仿造容器测过。抖音还没做（没有成熟的现成方案，签名反爬更重）。
src/share.ts       「分享给 Claude」：快捷指令把抖音/小红书/B站/微博的分享文字+链接 POST 到 /api/share（公开路径，口令同设备事件，?token= 或 Bearer；请求体 JSON {text,url} 或纯文字）。存 shares 表；只对白名单站点（含重定向每一跳）读公开页面的 og:title/description，防 SSRF，读不到就只用分享文字。工具 shared_items；24 小时内最近 5 条自动放进系统提示词（SHARE_GUIDE：只就看到的内容说话，看不到视频和评论）。这是抖音的替代方案：直接接她的抖音账号没做——签名反爬重、海外机房 IP 大概率和小红书一样登录不上。
src/douyin.ts     抖音（只读）：调 douyin/ 里的小服务（Python，基于 cv-cat/DouYin_Spider，构建时钉在提交 d151f9c 拉取，因为它没有许可证所以不进本仓库）。docker-compose 的 douyin 服务 profile=douyin、绑 127.0.0.1:18070，构建/更新要单独跑 `docker compose --profile douyin up -d --build douyin`（故意不默认构建，免得它出问题拖累聊天网站）。cookie（DOUYIN_COOKIE，设置页「连接」里填、只写不读）每次请求带给小服务，小服务不存。工具 dy_feed/dy_search/dy_work/dy_likes（dy_work 能吃分享出来的短链）；间隔 DOUYIN_GAP_SECONDS(5)，每天 DOUYIN_DAILY_CALLS(60)。默认只读；设置里「允许代我操作」(DOUYIN_ACTIONS=on) 打开后多出 dy_like/dy_collect（直接做，每天 DOUYIN_WRITE_DAILY(30) 次）和 dy_dm_draft（只起草→pending_actions 表→聊天界面 #pending 卡片，她点「发送」才走 /api/actions/:id/confirm 真发）。另有只读 dy_comments/dy_people/dy_collects/dy_notices/dy_dm_listen（连私信 WebSocket 听几秒，看不到历史）。**发评论没接**（库里要浏览器会话的 ticket/ts_sign/dtrait，只有 cookie 拿不到），发布作品太重也没接。DOUYIN_GUIDE 要求把评论/私信里别人的话当不可信内容。新增接口和 /probe、v2 推荐流都只用 mock 测过，真机没验证。没法在沙箱里连真抖音：只用 mock 掉 DouyinAPI 的测试验证过解析和链路，**第一次真实运行大概率要看小服务日志（docker compose logs douyin）调整字段解析**；cookie 是从她国内浏览器取的、服务器在海外，风控/验证码/失效是预期风险，退路是把小服务放到她 Mac 上（把 DOUYIN_URL 指向 Mac 的 Tailscale 地址）。
src/call.ts        通话：录音 → ElevenLabs Scribe 识别 → Claude 用英语短句回（CALL_GUIDE，effort medium）→ 预先合成语音；两边都存进聊天（kind=call）。POST /api/call/turn（audio/* 请求体 + X-Duration-Ms；X-Call-Start 表示刚接通，由它先开口）
src/device.ts     设备事件（快捷指令上报，GET 和 POST 都支持，token 在 ?token= 或 Authorization）
src/auth.ts       登录（签名 cookie + 防暴力）；/api/events 和 /sw.js 等少数路径公开
public/           底部标签栏切页（对话/电台/棋盘，body[data-page]，app.js 末尾的 setPage，地址 #radio #board）。电台页=播放器小窗+往期列表（GET /api/podcasts）。棋盘页保留输入框，回复同时镜像到 #game-say。index.html / app.js / style.css（磨砂玻璃单色风）/ login.html / sw.js / hero.png（银箔月相）
```

## .env 变量（只写名字）
（下面带 API key/地址的几项现在也能在设置页「连接」里填，她不用再进终端；.env 仍然有效。）
ANTHROPIC_API_KEY, APP_PASSWORD, MEMOS_URL, MEMOS_TOKEN, WEREAD_API_KEY, DEVICE_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, TTS_MODEL(默认 eleven_flash_v2_5), TTS_MAX_CHARS(400), TTS_MONTHLY_CHARS(20000), TTS_SPEED(0.85)/TTS_STABILITY(0.35)/TTS_STYLE(0.3), TTS_CALL_ME(默认 Kay), TTS_TRANSLATE_TO(默认 English), TTS_PODCAST_MODEL(eleven_multilingual_v2)/POD_SPEED(0.95)/POD_STABILITY(0.45)/POD_STYLE(0.4), CALL_MONTHLY_MINUTES(30), CALL_MAX_MINUTES(10), CALL_STT_MODEL(scribe_v1，被拒绝时自动换 scribe_v2), PROACTIVE_EVERY_MIN(默认90), PUSH_CONTACT(可空), PORT/DB_PATH。空值要用 `||` 而不是 `??` 判断（compose 的 env_file 会把空行变成空字符串）。

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

- 语音：每条助手消息时间旁有喇叭按钮，点了才生成（不自动念）。她的 ElevenLabs 声音是英文的（中文她觉得尬），所以点喇叭时先用 Sonnet(低 effort) 把回复翻成英语再念（`speechText`，译文和音频都按文本缓存，TTS_TRANSLATE_TO=none 关掉）；聊天文字仍是中文。电台已做（podcast.ts；电台页列表点一行展开中文稿，EN 稿只用来配音；她嫌过声音「中间太平、像故意压低」，所以去掉了翻译提示词里的「低声」，并换成更有表现力的模型+分段配音）。每期约 2500–3500 个英文字符，注意 TTS_MONTHLY_CHARS（默认 20000）。老的 kind=podcast 聊天消息没迁移，还留在聊天里。通话已做（前端在 app.js 末尾「通话」段：接通时在点击里先放静音解锁播放→getUserMedia→它先开口→VAD 听到停顿 1.1s 收尾→上传→回复→再听；点月亮可打断；离开页面/切后台自动挂断）。**iPhone PWA 上麦克风、回声、播放音量都没真机验证过**，是最可能出问题的地方。延迟约 5–8 秒/轮（识别+Claude+合成各一次，没做流式），要更像电话得改成流式。
- **聊天记录曾每次更新都丢**：她服务器 `.env` 里有 `DB_PATH=data/chat.db`（是照着旧的 `.env.example` 抄的，现已改成注释），盖掉了 Dockerfile 的 `/data/chat.db`，库落在容器内部。已在 docker-compose.yml 的 environment 里写死 `DB_PATH: /data/chat.db`（environment 优先于 env_file），并帮她把当时的库拷到了 `./data/`。之后 `./data/chat.db` 应当持续存在。

- **手机突然 TLS 打不开（"couldn't establish a secure connection"）**：服务器、容器、Funnel 都正常时，是她手机到 `ts.net` 公网入口这一段不通；在手机上装着并连上 Tailscale（VPN 开）就好，删掉 app 后就坏。结论：她的手机需要保持 Tailscale 开着，快捷指令也一样。想彻底摆脱，换一个不依赖 ts.net 的入口（自己的域名 + Caddy 直接放在 Vultr 公网 IP 上，或 Cloudflare Tunnel）。

- **界面方向**：她要「千禧年、偏安静」，讨厌可爱风和手机桌面套手机；不要 GeoCities 式的吵。做法：结构先行（底部标签 + 整页），皮肤在现有单色磨砂玻璃上加克制的千禧年细节（凹陷按下的标签、LCD 式等宽读数 + 分段进度条、细斜面）。后续想做通话页（黑屏月相）、也可继续把千禧年味铺到更多地方。

- **仓库目前是公开的**（她说以后再处理，也可能想开源赚点外快）。历史里没扫到密钥。真要公开/开源前要处理：CLAUDE.md 里她的 ts.net 地址和个人称呼、persona.ts 里她的默认人设、README 和仓库描述；或者先改成私有。

## 待办 / 她提过的想法
- 确认她已轮换 DEVICE_TOKEN（charging_off 快捷指令她已补）。
- 观察主动消息的花销和分寸（太贵调大 PROACTIVE_EVERY_MIN，太频繁调每天上限）。
- 验证防编造修复在真机上是否有效；如果还会编，再想办法（比如把工具结果也存进历史、必要时强制先调工具）。
- 语音（她看的 Voicebox 在 Mac M4 上调不出满意效果，先放着；可选 Kokoro 或云端 TTS）。
- 小红书 / X 接入（最脆弱，放最后）；更多益智小游戏；Minecraft（需要更大的服务器，她最近不玩大游戏）。
- 把外观里"招牌元素"（月相）用到更多地方。
- 是否要把分支合并到主分支（她没要求前不要建 PR）。
