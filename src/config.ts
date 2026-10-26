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
  id: "memos" | "weread" | "device" | "voice" | "xhs" | "douyin";
  title: string;
  hint: string;
  fields: Field[];
  qrcode?: boolean; // 设置页显示「登录二维码」按钮
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
    id: "douyin",
    title: "抖音（只读）",
    hint: "靠旁边的抖音小服务。需要你登录抖音网页版后的 cookie：在电脑浏览器登录 www.douyin.com，按 F12 → 网络(Network) → 筛选 Fetch/XHR → 点任意一个以 /aweme/v1/web/ 开头的请求 → 在「请求标头」里找到 Cookie，整串复制（要含 UIFID）。cookie 等于账号权限，只存在你自己的服务器上，这个页面不会再显示它。只能看推荐、搜索、作品和评论、你点过赞的，不能点赞评论发布。",
    fields: [
      { name: "DOUYIN_COOKIE", label: "Cookie", secret: true },
      { name: "DOUYIN_URL", label: "小服务地址", secret: false, placeholder: "http://127.0.0.1:18070（不用改）" },
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
