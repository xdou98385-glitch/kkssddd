// 可在设置页填写的连接配置（API key、地址等）。存在数据库里，优先于 .env；清空后退回 .env 里的值。
// 密钥只写不读：接口永远不把密钥发回浏览器（DEVICE_TOKEN 例外，她要拿去填快捷指令，需要点「查看」才返回）。
import * as db from "./db.ts";

export interface Field {
  name: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  reveal?: boolean; // 允许点「查看」读出来
  generate?: boolean; // 可以一键生成随机口令
}
export interface Group {
  id: "memos" | "weread" | "device" | "voice" | "xhs" | "douyin" | "music" | "weather" | "calendar" | "mail";
  title: string;
  hint: string;
  fields: Field[];
  qrcode?: boolean; // 设置页显示「登录二维码」按钮
  probe?: boolean; // 设置页显示「体检」按钮：把每个功能各试一遍
}

export const GROUPS: Group[] = [
  {
    id: "memos",
    title: "Memos 记忆",
    hint: "两项都填才启用。地址是 Memos 在这台服务器上的端口；Token 在 Memos 的 设置 → 我的账号 → Access Tokens 里生成。",
    fields: [
      { name: "MEMOS_URL", label: "地址", secret: false, placeholder: "http://127.0.0.1:5230" },
      { name: "MEMOS_TOKEN", label: "Token", secret: true },
    ],
  },
  {
    id: "weread",
    title: "微信读书",
    hint: "Agent Gateway 的 key，形如 wrk-xxxx。",
    fields: [{ name: "WEREAD_API_KEY", label: "API Key", secret: true }],
  },
  {
    id: "device",
    title: "设备动态（快捷指令）",
    hint: "快捷指令往服务器汇报时用的口令。可以一键生成；需要抄到快捷指令里时，点「查看」。",
    fields: [{ name: "DEVICE_TOKEN", label: "口令", secret: true, reveal: true, generate: true }],
  },
  {
    id: "voice",
    title: "语音（ElevenLabs）",
    hint: "电台、朗读和通话都用它。Voice ID 在 ElevenLabs 网站的 Voices 里复制。",
    fields: [
      { name: "ELEVENLABS_API_KEY", label: "API Key", secret: true },
      { name: "ELEVENLABS_VOICE_ID", label: "Voice ID", secret: false },
    ],
  },
  {
    id: "xhs",
    title: "小红书（只读）",
    hint: "靠旁边的 xiaohongshu-mcp 容器：它用浏览器替你登录，这里只填它的地址。点「登录二维码」，用小红书 app 扫一下就行，账号密码和 cookie 不会经过这个页面。只能搜索、看推荐、看笔记和评论，不能点赞评论发帖。",
    qrcode: true,
    fields: [
      { name: "XHS_URL", label: "地址", secret: false, placeholder: "http://127.0.0.1:18060" },
      { name: "XHS_TOKEN", label: "口令（可选）", secret: true },
    ],
  },
  {
    id: "calendar",
    title: "日历（谷歌，只读）",
    hint: "网页版 Google 日历 → 设置 → 左边点你的日历 → 滚到「集成日历」→ 复制「iCal 格式的私人地址」，粘贴到这里。这个地址等于钥匙，别发给别人。只能看日程，不能新建。",
    fields: [{ name: "GCAL_ICS_URL", label: "iCal 私人地址", secret: true }],
  },
  {
    id: "mail",
    title: "邮箱（Gmail，只读）",
    hint: "只看收件箱，不能发信、删信，看了也不会标成已读。需要「应用专用密码」：Google 账号先开两步验证，再打开 myaccount.google.com/apppasswords 生成一个 16 位密码（不是你的登录密码）。邮件内容会被 Claude 读到，不想让它看的邮箱别接主邮箱。",
    fields: [
      { name: "GMAIL_USER", label: "Gmail 地址", secret: false, placeholder: "xxx@gmail.com" },
      { name: "GMAIL_APP_PASSWORD", label: "应用专用密码", secret: true },
    ],
  },
  {
    id: "weather",
    title: "天气和位置",
    hint: "填一个城市，Claude 就能查天气。想让它知道你现在在哪（出门、换城市后天气自动跟着走），需要在 iPhone 快捷指令里设一个自动化，定时把位置报上来，我给你步骤。位置只精确到约 1 公里，6 小时没更新就退回这里填的城市。",
    fields: [{ name: "WEATHER_CITY", label: "城市", secret: false, placeholder: "大阪" }],
  },
  {
    id: "music",
    title: "听歌（Last.fm）",
    hint: "让 Claude 知道你在听什么。步骤：1) 注册 last.fm 账号；2) 在 Spotify（免费号也行）设置 → 第三方应用 里连上 Last.fm；3) 打开 last.fm/api/account/create 随便填个名字，拿到 API Key；4) 把 API Key 和你的 Last.fm 用户名填在这里。只读。",
    fields: [
      { name: "LASTFM_API_KEY", label: "API Key", secret: true },
      { name: "LASTFM_USER", label: "Last.fm 用户名", secret: false },
    ],
  },
  {
    id: "douyin",
    probe: true,
    title: "抖音",
    hint: "靠旁边的抖音小服务。需要你登录抖音网页版后的 cookie：在电脑浏览器登录 www.douyin.com，按 F12 → 网络(Network) → 筛选 Fetch/XHR → 点任意一个以 /aweme/v1/web/ 开头的请求 → 在「请求标头」里找到 Cookie，整串复制（要含 UIFID）。cookie 等于账号权限，只存在你自己的服务器上，这个页面不会再显示它。默认只读：推荐、搜索、作品和评论、点赞/收藏/关注/粉丝/通知、听新私信。「允许代我操作」填 on 后，Claude 可以直接点赞和收藏；发私信只会起草，必须你在聊天里点确认才发。发评论还要填「浏览器凭据」（和 cookie 同一次登录取的）；发布作品没接。",
    fields: [
      { name: "DOUYIN_COOKIE", label: "Cookie", secret: true },
      { name: "DOUYIN_URL", label: "小服务地址", secret: false, placeholder: "http://127.0.0.1:18070（不用改）" },
      { name: "DOUYIN_BROWSER", label: "浏览器凭据（发评论用）", secret: true },
      { name: "DOUYIN_DTRAIT", label: "设备特征（点赞/评论被拒时填）", secret: true },
      { name: "DOUYIN_ACTIONS", label: "允许代我操作", secret: false, placeholder: "填 on 开启；留空 = 只读" },
    ],
  },
];

const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f.name, f] as const)));
const listeners = new Set<() => void>();
/** 配置变了要重新计算「是否启用」的模块，在这里登记 */
export const onConfigChange = (fn: () => void): void => void listeners.add(fn);

const key = (name: string) => "cfg:" + name;

/** 读配置：设置页填的优先，没有就用 .env */
export const cfg = (name: string): string => (db.getSetting(key(name)) || process.env[name] || "").trim();
export const cfgSource = (name: string): "ui" | "env" | "none" => (db.getSetting(key(name)) ? "ui" : process.env[name]?.trim() ? "env" : "none");

export class ConfigError extends Error {}

/** value 为空字符串或 null 表示清除设置页里的值（退回 .env） */
export function setCfg(name: string, value: string | null): void {
  if (!FIELDS.has(name)) throw new ConfigError("未知的配置项");
  const v = (value ?? "").trim();
  if (v.length > 60000 || /[\r\n\0]/.test(v)) throw new ConfigError("内容不合法");
  db.setSetting(key(name), v);
}
export function notifyConfigChanged(): void {
  for (const fn of listeners) fn();
}

export function canReveal(name: string): boolean {
  return Boolean(FIELDS.get(name)?.reveal);
}

/** 给设置页用的列表：非密钥返回当前值，密钥只返回有没有设置、来源 */
export function describeGroups() {
  return GROUPS.map((g) => ({
    ...g,
    fields: g.fields.map((f) => ({ ...f, set: cfg(f.name) !== "", source: cfgSource(f.name), value: f.secret ? undefined : cfg(f.name) })),
  }));
}
