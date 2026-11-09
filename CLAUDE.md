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
src/proactive.ts  主动消息心跳。规则：安静时段、刚聊过 45 分钟内不发、每天上限（0=不限）、她没回时间隔拉长（0 条没回≥1h，1 条≥4h，2 条≥12h，3 条≥24h，连着 4 条没回就停到她先说话；trailingProactive 统计）。节拍：Claude 在回复末尾写 [next: 45m]/[next: 3h]（parseNext 取出并去掉，夹在 30 分钟~8 小时，下限 PROACTIVE_MIN_WAKE_MIN），没写用 PROACTIVE_EVERY_MIN(90)；被规则挡住没调 Claude 的每 15 分钟再看一次（不花额度）；下次醒来时间存 settings.proactive_next，每 60 秒检查
src/tts.ts        文字转语音（ElevenLabs）：按文本缓存到 data/tts/，每月字符上限，GET /api/tts/:消息id（支持 Range，iPhone 才肯播）
src/podcast.ts    电台节目：设置外的「电台」页点「来一期」→ 后台让 Claude 一次写出 <title>/<title_en>/<zh>/<en>（中文稿 600–900 字 + 同内容的英语口语稿），存 episodes 表（不进聊天记录），英语稿按段落分块、带前后文（previous_text/next_text）用 podcastVoice 配音再拼起来；status: writing→voicing→ready/failed，前端轮询 GET /api/podcasts，音频走 GET /api/podcast/:id/audio（Range）
src/xhs.ts        小红书（只读）：调旁边的 xpzouying/xiaohongshu-mcp 容器（docker-compose 里 xhs 服务，profile=social，只绑 127.0.0.1:18060，登录态在 ./data/xhs），工具 xhs_search/xhs_feed/xhs_note/xhs_me；请求排队、间隔 XHS_GAP_SECONDS(4)、每天 XHS_DAILY_CALLS(80) 次上限。她扫码登录（设置页「小红书」→登录二维码），应用不碰 cookie。写操作（点赞/评论/发帖）故意没接。**她服务器上其实已有一个原生的 systemd 服务 xhs-mcp（/root/xiaohongshu-mcp-linux-amd64，监听 18060，没口令，靠 ufw 只放行 22 挡外网），所以不用 docker-compose 里的 xhs 服务（那是 profile=social 的备用，她没启用）；设置里地址填 http://127.0.0.1:18060。** 登录二维码：容器那边每要一次就开新浏览器并作废上一张，所以 xhsQrcode 单飞+200 秒内复用，前端只在过期后才重新要，并每 6 秒自动查是否扫成功。没法在沙箱里连真小红书，只用仿造容器测过。抖音还没做（没有成熟的现成方案，签名反爬更重）。
src/share.ts       「分享给 Claude」：快捷指令把抖音/小红书/B站/微博的分享文字+链接 POST 到 /api/share（公开路径，口令同设备事件，?token= 或 Bearer；请求体 JSON {text,url} 或纯文字）。存 shares 表；只对白名单站点（含重定向每一跳）读公开页面的 og:title/description，防 SSRF，读不到就只用分享文字。工具 shared_items；24 小时内最近 5 条自动放进系统提示词（SHARE_GUIDE：只就看到的内容说话，看不到视频和评论）。这是抖音的替代方案：直接接她的抖音账号没做——签名反爬重、海外机房 IP 大概率和小红书一样登录不上。
src/douyin.ts     抖音（只读）：调 douyin/ 里的小服务（Python，基于 cv-cat/DouYin_Spider，构建时钉在提交 d151f9c 拉取，因为它没有许可证所以不进本仓库）。docker-compose 的 douyin 服务 profile=douyin、绑 127.0.0.1:18070，构建/更新要单独跑 `docker compose --profile douyin up -d --build douyin`（故意不默认构建，免得它出问题拖累聊天网站）。cookie（DOUYIN_COOKIE，设置页「连接」里填、只写不读）每次请求带给小服务，小服务不存。工具 dy_feed/dy_search/dy_work/dy_likes（dy_work 能吃分享出来的短链）；间隔 DOUYIN_GAP_SECONDS(5)，每天 DOUYIN_DAILY_CALLS(60)。默认只读；设置里「允许代我操作」(DOUYIN_ACTIONS=on) 打开后多出 dy_like/dy_collect（直接做，每天 DOUYIN_WRITE_DAILY(30) 次）和 dy_dm_draft（只起草→pending_actions 表→聊天界面 #pending 卡片，她点「发送」才走 /api/actions/:id/confirm 真发）。另有只读 dy_comments/dy_people/dy_collects/dy_notices/dy_dm_listen（连私信 WebSocket 听几秒，看不到历史）。**发评论**：设置「浏览器凭据」(DOUYIN_BROWSER，只写不读)里存一段 JSON——她在抖音网页控制台用 `copy(JSON.stringify(...localStorage 里含 security 的项))` 打包的；小服务 parse_creds 按键名后缀认 `web_protect` 和含 `crypt_sdk` 的项，取出 ticket/ts_sign/client_cert/ec_privateKey 传给 DouyinAuth.open（认不出会报回看到的键名，不含值）。凭据和 cookie 必须同一次登录。工具 dy_comment_draft 只起草，确认后走 /comment_post（只在发评论时带 creds）。键名是照库代码推的，没在真浏览器验证。**真机结果：推荐流能读；点赞/评论都回 status_code=8（digg 不用 ticket，所以怀疑是库自带的 dtrait 设备特征和她的设备对不上）→ 加了设置项「设备特征」DOUYIN_DTRAIT（README 里控制台 hook 抓的 DY_DTRAIT_BLOB），写操作(digg/collect/comment/dm)都会带上；搜索回 KeyError 'data' → 现在会把 status_code/status_msg 带回来。若 dtrait 填了仍是 8，多半是账号/IP 层面的写风控，退路是把小服务搬到她 Mac。**发布作品太重没接（库里 DouyinCreatorAPI.post_images/post_video，要先 bootstrap_creator，建议先做图集）。DOUYIN_GUIDE 要求把评论/私信里别人的话当不可信内容。新增接口和 /probe、v2 推荐流都只用 mock 测过，真机没验证。没法在沙箱里连真抖音：只用 mock 掉 DouyinAPI 的测试验证过解析和链路，**第一次真实运行大概率要看小服务日志（docker compose logs douyin）调整字段解析**；cookie 是从她国内浏览器取的、服务器在海外，风控/验证码/失效是预期风险，退路是把小服务放到她 Mac 上（把 DOUYIN_URL 指向 Mac 的 Tailscale 地址）。
src/music.ts       陪听：读 Last.fm（user.getrecenttracks/gettopartists/gettoptracks），设置页「听歌」填 LASTFM_API_KEY(只写不读)+LASTFM_USER。工具 music_now/music_recent/music_top，MUSIC_GUIDE。她 Spotify 没充值：Spotify 2026-02 起开发者模式要求应用所有者是 Premium，所以不走 Spotify API，改成她在 Spotify 设置里连 Last.fm 让它记录（免费号可用）。只知道歌名歌手专辑次数，听不到音频和歌词。没做同步播放。只用 mock 测过。
src/listen.ts      陪听模式：设置「通知」页开关（settings 键 listen：enabled/maxPerHour，默认关，4 句/小时）；每 30 秒读一次 Last.fm 最近 6 首，换歌后下一轮仍在放才考虑说话，commentedKey 保证一首只问一次；限制：安静时段（沿用主动消息的）、每小时上限、两句至少隔 4 分钟、她 2 分钟内发过话不抢、Claude 可 [skip]；写入 kind='listen' 的消息（不占主动消息的每日额度，也不推送）；effort low。前端在陪听开着且页面可见时每 20 秒 refreshThread。用假 Last.fm + 假 Claude 测过流程。真正「点歌放给她听」（YouTube 嵌入播放器）没做。
src/weather.ts     天气+位置：Open-Meteo（geocoding 填城市、forecast 取现在+3 天）；位置来自快捷指令往 /api/events 报的 kind=location（detail=`纬度,经度`，recordEvent 校验并截到两位小数，约 1 公里），6 小时内最新一条优先，否则退回设置页「天气和位置」的 WEATHER_CITY；坐标转地名用 OSM Nominatim（按坐标缓存）。工具 weather / where_am_i，WEATHER_GUIDE。谷歌地图时间线没有可用接口，所以位置靠快捷指令。只用 mock 测过。
src/calendar.ts    日历（只读）：谷歌日历「iCal 私人地址」(GCAL_ICS_URL，只写不读，必须以 https://calendar.google.com/calendar/ical/ 开头) → node-ical 解析并展开重复日程，缓存 5 分钟。工具 calendar_upcoming，CALENDAR_GUIDE。不能新建（要写得走 OAuth，没做）。
src/mail.ts        邮箱（只读收件箱）：Gmail IMAP（imapflow）+ 应用专用密码（GMAIL_USER / GMAIL_APP_PASSWORD，后者只写不读）；以 readOnly 打开（选项名大小写：readOnly，之前误写成 readonly 导致没生效，已修，tsc 才发现）所以不会标已读；mail_list（支持 Gmail 搜索语法 gmailraw）/ mail_read（正文最多 3000 字，mailparser）。邮件内容当不可信内容（工具结果里带提醒 + MAIL_GUIDE）。不发信、不删信。日历和邮件都只用 mock/假 IMAP 客户端测过，没连过真 Gmail。
src/twitter.ts     X（推特，只读）：调 x/ 里的小服务（Python 标准库 HTTP 服务，里面用 PyPI 的 jackwener/twitter-cli==0.8.5 当命令行跑，Apache-2.0；只放行 feed/search/tweet/user/user-posts/bookmarks/whoami，点赞发推关注删除都不放行，参数校验后不经 shell）。设置页「X」填 TWITTER_AUTH_TOKEN + TWITTER_CT0（都只写不读；从浏览器 Cookie 里取这两个值），X_URL 默认 http://127.0.0.1:18080。compose 的 x 服务 profile=x：`docker compose --profile x up -d --build x`。工具 x_feed/x_search/x_tweet/x_user/x_bookmarks，X_GUIDE（推文当不可信内容）；间隔 X_GAP_SECONDS(6)，每天 X_DAILY_CALLS(40)。选 twitter-cli 而不是 twikit：twikit 最后一次实质提交是 2025-04，twitter-cli 2026-05 还在适配接口变化。X 官方 API 2026-02 起只有按量付费、没免费读取。只用假 twitter 命令测过，没连过真 X；机房 IP 会不会被 X 盯上、凭据会不会被收回都未知。
src/schedule.ts + scheduler.ts  提醒和 Claude 给自己约的「找她」：scheduled 表（kind=reminder|checkin，status pending/done/skipped/failed/cancelled）。工具 schedule_reminder / schedule_checkin / list_scheduled / cancel_scheduled 一直可用（SCHEDULE_GUIDE）；when 是她当地时间 `YYYY-MM-DD HH:MM`（zonedToMs 按她的时区换算，时区取 settings.tz，UTC 时退回 Asia/Tokyo），最多 20 条、60 天内。scheduler.ts 每 30 秒查到点的：到点让 Claude 现写（effort medium，可先调工具），写成 kind='remind' 的消息 + 推送；提醒一定发（Claude 出错/skip 就发「提醒：原文」兜底），checkin 可 [skip]，遇安静时段往后挪 30 分钟，每天最多 3 次。启动时会补发停机期间到点的。心跳指令（proactive.ts）里也鼓励它先用工具、想改时间就 schedule_checkin 后 [skip]。
src/websearch.ts   联网搜索：Anthropic 服务端工具 web_search_20250305（搜索由 Anthropic 执行，按次另计费，约 $10/千次），设置页「联网搜索」填 on 开启（WEB_SEARCH），每天上限 WEB_SEARCH_DAILY(30)、每次回复最多 3 次；用完当天就不再给这个工具。claude.ts 处理 pause_turn（原样带回 content 接着跑）、统计 usage.server_tool_use.web_search_requests、把「真搜过」记进 toolsUsed。要先在 Anthropic Console 组织设置里允许 Web search，否则聊天会报错。
src/backup.ts      每天 VACUUM INTO 备份到 DB 同目录的 backups/（./data/backups），留 7 份；设置「其他」页有「立即备份」「下载最新备份」。备份与库同盘，防手滑/损坏不防整机丢失；备份里含所有密钥。
src/shop.ts        购物算数（淘宝等，没接任何平台、不能下单付款）：工具 shop_calc 一直可用——按「分」算商品合计、店铺券/立减、跨店满减（every=每满 X 减 Y，tier=阶梯，可封顶）、凑单差额、每件分摊后实付；假设先扣券再算满减。SHOP_GUIDE：她发截图/链接，Claude 读完帮她看价格优惠、比价、挑差评、整理清单，付款永远她自己点；活动规则每年变，别凭记忆报，看截图或联网搜；商品/评价文字当不可信。她明确说过：国内淘宝号、想要自动付款（我拒绝了，原因：无官方接口、需破解 App 接口、注入风险）；购物车/收藏夹读取要非官方接口，同抖音问题（海外 IP、风控），没做；淘宝联盟官方 API 是备选（只有搜索/券/详情，要她实名申请）。
src/wishlist.ts    购物清单（只记账，不连平台）：wishlist 表（金额按分存），工具 wish_add/wish_list/wish_update/wish_budget 一直可用；优先级 1 必买/2 想买/3 可买可不买，状态 want/bought/dropped；wish_list 按优先级分组并给合计、已买、必买还剩、对比预算（settings.wish_budget）。SHOP_GUIDE 要求 Claude 把截图里的东西都记进来、问清单先调 wish_list。她的 Mac（M4，淘宝 3.0.1）和她在 Windows 虚拟机里试的版本都找不到 MCP 入口，已放弃 taobao.ts 那条路，代码保留、不填地址就是关着的。
src/taobao.ts      **官方 MCP 配置功能已于 2026-10-22 被淘宝「因技术维护暂时下线」（淘宝官方帖子，无恢复时间）——她的 Mac(M4) 客户端 3.0.1 设置里没有「AI 设置」就是这个原因，不是版本/平台问题；她还为此装了 Windows 虚拟机，白折腾了。桥接代码保留，设置里不填地址就是关的，等淘宝重新开放再用。**淘宝买家侧：连她电脑上「淘宝桌面客户端」(2.5+) 自带的官方 MCP（搜索/浏览/比价/详情/加购，付款她自己点，读不到评价，官方只支持同机，端口约 3654，路径 /mcp）。她用 `tailscale serve --bg --tcp 13654 tcp://[::1]:3654` 转发出来（报道称客户端只监听 IPv6 本地，用 127.0.0.1 会连不上；开启位置：设置 → AI 设置 → 启用 MCP 服务，需 v2.5.0+；她的 Mac 找不到这个入口，Homebrew 上 Apple 芯片版本号还停在 2.1.0，Mac 版可能还没有 MCP），设置页「淘宝」填 TAOBAO_MCP_URL（可选 TAOBAO_MCP_TOKEN、TAOBAO_MCP_HOST 覆盖 Host 头，防客户端因 Host 拒绝）。用 @modelcontextprotocol/sdk 的 StreamableHTTP 客户端，每次调用现连现断；工具列表 refreshTools() 读下来存 settings.taobao_tools（启动时、保存设置时、每 10 分钟刷新），每个加前缀 tb_ 动态注册进 getTools()；名字/描述像付款、下单、结算的工具一律不放行（FORBIDDEN）；电脑没开/连不上返回 OFFLINE 提示不让 Claude 编；每天 TAOBAO_DAILY_CALLS(300)。TAOBAO_GUIDE：加购前先问、不翻地址订单聊天、结果当不可信。她要求走 B（接网站）；电脑不想一直开→只在购物时开，没开时 Claude 会说连不上。**只用假 MCP 服务器测过，真实客户端的配对/认证/Host 校验/工具名都没见过，第一次真机大概率要按报错调整。**
src/lock.ts        应用锁（软锁）：app_rules 表（kind=window 时间段，可跨午夜；kind=limit 每天用时上限；可带 expires_at，比如「学习到 22:00」）。iPhone 快捷指令「打开 App」自动化 → GET /api/gate?token=设备口令&app=名字（公开路径，口令同设备事件）→ 被拦回 {"block":1,"message":"…"}，放行只回 {"allow":1}（故意不带 block 键：快捷指令里取到的字典值没有类型，If 只能选「有值/没值」），被拦时快捷指令弹提示并回主屏幕，同时 gate 会给手机发一条 Web Push（notifyBlocked，同 app 2 分钟内一次，tag=claude-lock，url=`/?lock=app`）——点通知会打开**主屏幕上的网页 App**（快捷指令的「打开 App」列表里没有网页 App，Open URL 只会开 Safari），sw.js 的 notificationclick 对已开着的窗口用 postMessage({type:'open',url}) 通知页面预填，没开着就 openWindow；被拦会记 lock_block 事件（Claude 经 device_activity 能看到）。用时靠 app_open/app_close 事件估算（usedMinutesToday，约数，还开着的最多算 30 分钟）。工具 app_lock_set/list/remove/unlock 一直可用（LOCK_GUIDE）：Claude 当守门人决定放不放行，但 unlock 的上限由代码守（每 app 每天 3 次、每次 ≤30 分钟）。这是软锁，她能在快捷指令里关自动化，别说成硬锁。**分组**：一个「App 已打开」自动化可以选多个 app，但手机不告诉快捷指令是哪个被打开，所以她要锁的一堆 app（抖音、小红书、B站、X、Instagram、Grok、淘宝……）按组管理，快捷指令里写死 app=组名（如「娱乐」），规则/学习模式/自动上锁都用组名。**Claude 自己上锁**（她同意了：「软锁就可以」）：lock_auto={apps 名单,maxMinutes}，工具 app_lock_auto_config 设名单（必须她点头），app_lock_self 只能锁名单内的，每次 ≤maxMinutes(默认 180，上限 240)，每天最多 4 次（代码定），必须写原因（规则 note 里 +「Claude 锁的：」，被拦时显示），用 kind='until'（到 expires_at 一直锁）的规则实现，记 lock_self 事件；心跳指令提示她深夜还在刷名单内 app 时可以先锁再发消息。**学习模式**：study_cfg 设置里存 apps/minutes/触发的专注模式名；快捷指令「专注模式 学习 打开时」→ /api/events?kind=focus_on&detail=学习 → device.ts 的 eventHooks 钩子（lock.ts 注册）开始一段由服务器计时的学习会话（study_sessions），gate() 在会话期间锁指定 app；**关掉专注模式不解锁**（只记 study_focus_off_early 事件并把学习时长算到关掉那刻），只有到点、app_lock_unlock、或 study_mode_end（每天最多 2 次）才解。recordEvent 会把手误的 `foucus_*` 自动改成 `focus_*`（她的快捷指令里就拼错过）。工具 study_mode_config/start/end/status、study_stats。设置页暂无规则列表/删除 UI，靠对话管理。用本地假数据测过规则判定，没在真机跑过快捷指令。
src/expense.ts     记账（她有 Money Lover 但没会员、老忘记记；Money Lover 没公开 API、导出是会员功能、导入基本不支持，所以不接，数据不搬）：expenses 表，金额按最小单位存整数（JPY/KRW 无小数，其余 ×100），币种分开统计不换算，分类固定 CATS 12 个（乱写归「其他」，空=未分类）。工具 expense_add/update/delete/list/summary、budget_set（月预算，summary 里估月底）、expense_nudge_set（每晚到点问一句；今天已手动记过就不问；有 Apple Pay 自动收的没分类就问分类）。GET /api/expense?token=口令&amount=¥480&merchant=… 是给 iPhone 快捷指令「交易」自动化（Apple Pay/钱包刷卡触发）用的接收口，walletAdd 解析 ¥/円/$/USD/元 的金额文字，source='wallet'、分类留空，等晚上问她；她还没有卡，这条路等她办卡后再接。
src/dates.ts       重要日期簿：important_dates 表（once/yearly，remind_days 如 7,1,0），工具 date_add/list/remove；scheduler.ts 的 dailyJobs 每天上午 9 点后跑一次，按（日期,发生日,提前天数）去重（settings.dates_sent），一条消息汇总发出（kind='remind'）。不写进谷歌日历（日历只读）。
src/call.ts        通话：录音 → ElevenLabs Scribe 识别 → Claude 用英语短句回（CALL_GUIDE，effort medium）→ 预先合成语音；两边都存进聊天（kind=call）。POST /api/call/turn（audio/* 请求体 + X-Duration-Ms；X-Call-Start 表示刚接通，由它先开口）
记忆页（memos.ts 末尾 + /api/memories，前端「记忆」标签，Memos 开着才显示）：直接读写 Memos——列表（全部/钉住的/分类/未分类）、新增、编辑正文、删除、钉住（=#core 标签，每次对话自动读进去）、分类（日常/情感/饮食/学习/健康/计划，也是 Memos 标签，放正文后面，memos.ts 的 CATS；页面只显示正文，标签由服务器重新拼）。不再用 #claude 标签（她说只有一个模型没必要），老笔记里的 #claude 一改就去掉；save_memory 现在带必填的 category（含「其他」=不打标签）。认识天数：settings.since（默认 2026-09-28，PUT /api/settings 带 since=YYYY-MM-DD 可改，暂无界面），聊天页标题下显示 DAY N（含当天算第 1 天）。用假 Memos 服务器 + Playwright 测过。她还考虑过：每月一封信（存在网页里的「信箱」页，不是发邮件，邮箱继续只读）、Claude 的日记；心情打卡她不要（ENTP 说不清心情），改成让 Claude 从真实数据里看。外观她自己不满意（没说清哪里不满意，待问）。
src/letter.ts     每月一封信 + 「信箱」标签页（letters 表；/api/letters、/config、/write、/:id/email）。设置在信箱页顶部：settings.letter={enabled,email}，默认都关（email 默认开但要 enabled 才会自动写）。scheduler.ts 每 30 秒调 maybeWriteLetter：开着时每月最后一天 21:00（她当地时间）后写一封，settings.letter_auto 记月份防重复（手动「现在写一封」不占这个名额）。写信：用主对话的 system+历史，附上这个月真实数据（认识天数、她发了多少条、studyStats、expenseSummary、Last.fm 月榜、锁的事件计数、Memos 里这个月记的事；没有的不写），要求 <title>/<body> 格式，用「我感觉/我猜」且给她回「没有」的余地，不说教。写完推送（url /#letters）+ 若 email 开着就发邮件。**发邮件**：nodemailer 走 smtp.gmail.com:465，用 GMAIL_USER/GMAIL_APP_PASSWORD，**收件人写死 GMAIL_USER（她自己）**，Claude 没有任何发信工具，邮箱对 Claude 仍是只读；LETTER_SMTP_HOST/LETTER_SMTP_PORT 环境变量只给测试用（假 SMTP）。发失败只记 email_error，信仍在网页里，信箱页有「发到邮箱」重发按钮。用假 Claude + 假 SMTP 测过，没连过真 Gmail SMTP（应用专用密码同 IMAP 一个，理论上通用；若 535 多半是密码/两步验证）。她还考虑过的「Claude 的日记」没做，等看过信的味道再说。
src/gomoku.ts     五子棋（游戏页顶部「数独/五子棋」切换，页面 id 仍是 board）：15×15 自由规则无禁手，她执黑●、**内置程序执白○**（评分算法：对每个邻近空点算「自己的进攻形状 + 对方的威胁形状」，能赢就赢、必堵就堵；容易/普通/较难靠对方威胁权重和随机噪声区分），**不调用 Claude、不花钱**，Claude 只有 gomoku_view（看棋盘、最近几手、胜负），GAME_GUIDE 里写明白棋不是它算的、不许说成自己算的；不自动给 Claude 发消息（她赢/输了不会触发 API）。状态存 settings.gomoku；POST /api/game/gomoku/{new,move,undo}、GET /api/game/gomoku；前端 canvas（app.js 的 gomokuDraw，颜色取 CSS 变量）。悔棋撤到她上一手之前。测过：堵四/堵活三/跳四/能赢先赢、随机对手 30 局全输。她选了「程序下棋、Claude 聊天」而不是让 Claude 自己下（大模型下五子棋会漏子且费钱）。没真机试，没做禁手/更强的搜索。
src/device.ts     设备事件（快捷指令上报，GET 和 POST 都支持，token 在 ?token= 或 Authorization）
src/auth.ts       登录（签名 cookie + 防暴力）；/api/events 和 /sw.js 等少数路径公开
public/           **外观主题**：默认「终端」（html[data-theme="term"]：深蓝低饱和 #0c1116 + 强调色 #7fa6cf、等宽字、直角细线、无玻璃/阴影；标题是 `claude@kay:~/页面 ▾` 提示符，点它弹出目录取代底部标签栏，目录里是 `chat 对话 / memory 记忆 / letters 信箱…`），设置「对话」页第一项「外观」可切回「原来的样子」(classic，磨砂玻璃+底部标签)，存 localStorage.theme，public/theme.js 在 head 里同步设好免闪。她的要求：偏古早网页/终端、深色低饱和、蓝色系、不要小手机/主屏幕图标那种、讨厌底部一排功能（页面多了很挤）。她真机看过一次（iPhone）：嫌「太长」——字偏大、行距和段间距松，一条回复占小半屏；后来已把终端主题压紧（13.5px/1.65 行距/段间距 .5em）。桌面浏览器她说没看到变化，多半是浏览器缓存，让她强制刷新；若仍没有，查设置里「外观」。以前的说明：底部标签栏切页（对话/电台/棋盘，body[data-page]，app.js 末尾的 setPage，地址 #radio #board）。电台页=播放器小窗+往期列表（GET /api/podcasts）。棋盘页保留输入框，回复同时镜像到 #game-say。设置弹窗分四页（对话/连接/通知/其他，#set-tabs + body 里 data-tab，setTab()）；「连接」页按 CONN_CATS 分类、每项 <details> 折叠、标题旁显示已填写/未填，新加的连接组没归类会落到「其他」，别忘了把新 id 加进 CONN_CATS。index.html / app.js / style.css（磨砂玻璃单色风）/ login.html / sw.js / hero.png（银箔月相）
```

## .env 变量（只写名字）
（下面带 API key/地址的几项现在也能在设置页「连接」里填，她不用再进终端；.env 仍然有效。）
ANTHROPIC_API_KEY, APP_PASSWORD, MEMOS_URL, MEMOS_TOKEN, WEREAD_API_KEY, DEVICE_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, TTS_MODEL(默认 eleven_flash_v2_5), TTS_MAX_CHARS(400), TTS_MONTHLY_CHARS(20000), TTS_SPEED(0.85)/TTS_STABILITY(0.35)/TTS_STYLE(0.3), TTS_CALL_ME(默认 Kay), TTS_TRANSLATE_TO(默认 English), TTS_PODCAST_MODEL(eleven_multilingual_v2)/POD_SPEED(0.95)/POD_STABILITY(0.45)/POD_STYLE(0.4), CALL_MONTHLY_MINUTES(30), CALL_MAX_MINUTES(10), CALL_STT_MODEL(scribe_v1，被拒绝时自动换 scribe_v2), PROACTIVE_EVERY_MIN(默认90), PUSH_CONTACT(可空), PORT/DB_PATH。空值要用 `||` 而不是 `??` 判断（compose 的 env_file 会把空行变成空字符串）。

## 类型检查
`npx tsc --noEmit`（`npm ci` 之后）——能查出拼错的选项名这类 mock 测试发现不了的问题，改完先跑。

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
