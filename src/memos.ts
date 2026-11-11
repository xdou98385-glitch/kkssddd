// Memos 记忆后端。只用 v0.22+ 的公开接口：GET/POST /api/v1/memos，Bearer token。
import { cfg, onConfigChange } from "./config.ts";

const base = () => cfg("MEMOS_URL").replace(/\/+$/, "");
const token = () => cfg("MEMOS_TOKEN");

export let memosEnabled = false; // 设置页改了配置会重新计算（别的模块里是实时绑定）
const refresh = () => { memosEnabled = base() !== "" && token() !== ""; };
onConfigChange(() => { refresh(); cache = null; });
refresh();

export interface Memo {
  name: string;
  content: string;
  createTime: string;
  files: string[]; // 作为「附件」挂在笔记上的图片，在 Memos 上的路径（正文里的 ![](…) 图片不算）
}

async function memosFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(base() + path, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Memos ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** 连接状态，给设置页和启动日志用：没配置 / 已连接 / 连不上（带原因） */
export async function memosStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string }> {
  if (!memosEnabled) return { enabled: false };
  try {
    await memosFetch("/api/v1/memos?pageSize=1");
    return { enabled: true, ok: true };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const why = e.cause ? ` (${e.cause.code ?? e.cause.message})` : "";
    return { enabled: true, ok: false, error: e.message + why };
  }
}

// 个人笔记量不大，直接拉下来在本地搜；缓存 30 秒，避免每条消息都重拉
let cache: { at: number; memos: Memo[] } | null = null;
const MAX_PAGES = 10;

/** 笔记的附件列表里的图片 → Memos 文件地址。新版叫 attachments（/file/attachments/uid/文件名），老版叫 resources（/file/resources/编号/文件名），两种都试 */
function attachmentPaths(m: any): string[] {
  const out: string[] = [];
  for (const a of [...(m.attachments ?? []), ...(m.resources ?? [])]) {
    if (!String(a?.type ?? "").startsWith("image/")) continue;
    const kind = String(a.name ?? "").split("/")[0] === "resources" ? "resources" : "attachments";
    const id = String(a.uid || String(a.name ?? "").split("/")[1] || "");
    if (id && a.filename) out.push(`/file/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(String(a.filename))}`);
  }
  return out;
}

async function allMemos(): Promise<Memo[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.memos;
  const memos: Memo[] = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ pageSize: "200" });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await memosFetch(`/api/v1/memos?${qs}`);
    for (const m of data.memos ?? [])
      memos.push({ name: m.name, content: String(m.content ?? ""), createTime: String(m.createTime ?? ""), files: attachmentPaths(m) });
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  cache = { at: Date.now(), memos };
  return memos;
}

const day = (t: string) => t.slice(0, 10);
const IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const forClaude = (c: string) => c.replace(IMG_RE, "[附图]").trim() + "";
const fmt = (m: Memo) => `[${day(m.createTime)}] ${forClaude(m.content)}${m.files.length ? ` [附图 ${m.files.length} 张]` : ""}`;

/** 关键词搜索：按空格拆词，命中词越多越靠前，其次越新越靠前 */
export async function searchMemos(query: string, limit = 8): Promise<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "查询词是空的";
  const scored = (await allMemos())
    .map((m) => {
      const text = forClaude(m.content).toLowerCase();
      return { m, hits: words.filter((w) => text.includes(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.m.createTime.localeCompare(a.m.createTime))
    .slice(0, Math.min(Math.max(limit, 1), 20));
  if (!scored.length) return "没有找到相关记忆";
  return scored.map((x) => fmt(x.m)).join("\n---\n");
}

export async function saveMemo(content: string, category = ""): Promise<string> {
  const text = content.trim();
  if (!text) throw new Error("内容是空的");
  await memosFetch("/api/v1/memos", {
    method: "POST",
    body: JSON.stringify({ content: compose(text, (CATS as readonly string[]).includes(category) ? category : "", false), visibility: "PRIVATE" }),
  });
  cache = null;
  return "已保存";
}

/** 带 #core 标签的笔记会在每次对话开头自动读进去，用来放最重要的长期信息 */
export async function coreMemories(): Promise<string> {
  const core = (await allMemos()).filter((m) => /(^|\s)#core(\s|$)/.test(m.content));
  return core.map((m) => m.content.replace(/(^|\s)#core(?=\s|$)/g, "").trim()).join("\n---\n");
}

// ---- 记忆页：她在网页上直接看、改、删、钉住、分类 ----
// 分类和钉住都是 Memos 标签：#日常 这类放在正文后面，#core 表示钉住。老的 #claude 标签不再用，碰到就去掉。
export const CATS = ["日常", "情感", "饮食", "学习", "健康", "计划"] as const;
export interface MemoryItem { id: string; content: string; createTime: string; core: boolean; cat: string; images: string[] }

const TAG_RE = new RegExp(`(^|\\s)#(core|claude|${CATS.join("|")})(?=\\s|$)`, "g");
const tidy = (c: string) => c.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const plainOf = (c: string) => tidy(c.replace(TAG_RE, "$1").replace(IMG_RE, ""));
const catOf = (c: string) => CATS.find((k) => new RegExp(`(^|\\s)#${k}(?=\\s|$)`).test(c)) ?? "";
const isCore = (c: string) => /(^|\s)#core(?=\s|$)/.test(c);
/** 正文里的图片原样保留（![](…)），改正文时不能把图弄丢 */
const rawImgs = (c: string) => [...c.matchAll(IMG_RE)].map((m) => m[0]);
const compose = (text: string, cat: string, core: boolean, imgs: string[] = []) => [text, imgs.join("\n"), [cat && "#" + cat, core && "#core"].filter(Boolean).join(" ")].filter(Boolean).join("\n\n");
const idOf = (name: string) => name.replace(/^memos\//, "");
const check = (id: string) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("记忆编号不对"); return id; };

/** 图片地址 → 网页能用的地址：Memos 自己的图（相对路径，或同一个站点的完整地址）走我们的代理（带令牌，私有笔记才看得到）；别处的图直接用 */
function imgUrl(src: string): string | null {
  let path = "";
  if (src.startsWith("/") && !src.startsWith("//")) path = src;
  else {
    try {
      const u = new URL(src), b = new URL(base());
      if (u.origin === b.origin) path = u.pathname + u.search;
      else return u.protocol === "https:" ? u.href : null;
    } catch { return null; }
  }
  return `/api/memories/media?p=${encodeURIComponent(path)}`;
}

export async function listMemories(): Promise<MemoryItem[]> {
  cache = null; // 页面要看最新的
  return (await allMemos())
    .map((m) => ({
      id: idOf(m.name), content: plainOf(m.content), createTime: m.createTime, core: isCore(m.content), cat: catOf(m.content),
      images: [...[...m.content.matchAll(IMG_RE)].map((x) => x[1]), ...m.files].map(imgUrl).filter((x): x is string => Boolean(x)),
    }))
    .sort((a, b) => b.createTime.localeCompare(a.createTime));
}

/** 只放行 Memos 自己的文件地址，且必须是图片；防止被拿来当跳板访问别的地址 */
export async function memoryMedia(path: string): Promise<{ body: ArrayBuffer; type: string } | null> {
  if (!memosEnabled || !/^\/(file|o|api\/v1)\/[A-Za-z0-9_\-/.%+()~]+(\?[A-Za-z0-9_=&.%-]*)?$/.test(path) || path.includes("..")) return null;
  const res = await fetch(base() + path, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(15_000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return null;
  const body = await res.arrayBuffer();
  return body.byteLength > 15_000_000 ? null : { body, type };
}

export async function addMemory(content: string, cat = ""): Promise<void> {
  const text = content.trim();
  if (!text) throw new Error("内容是空的");
  await memosFetch("/api/v1/memos", { method: "POST", body: JSON.stringify({ content: compose(text, (CATS as readonly string[]).includes(cat) ? cat : "", false), visibility: "PRIVATE" }) });
  cache = null;
}

/** 改正文、分类、钉住中的任意几样，没传的保持原样（标签和正文里的图片自动保留） */
export async function updateMemory(id: string, patch: { content?: string; cat?: string; core?: boolean }): Promise<void> {
  cache = null;
  const raw = (await allMemos()).find((m) => idOf(m.name) === check(id));
  if (!raw) throw new Error("找不到这条记忆");
  const imgs = rawImgs(raw.content);
  const text = patch.content === undefined ? plainOf(raw.content) : patch.content.trim();
  if (!text && !imgs.length) throw new Error("内容是空的，要删就点删除");
  const cat = patch.cat === undefined ? catOf(raw.content) : (CATS as readonly string[]).includes(patch.cat) ? patch.cat : "";
  await memosFetch(`/api/v1/memos/${id}?updateMask=content`, { method: "PATCH", body: JSON.stringify({ content: compose(text, cat, patch.core ?? isCore(raw.content), imgs) }) });
  cache = null;
}

export async function deleteMemory(id: string): Promise<void> {
  await memosFetch(`/api/v1/memos/${check(id)}`, { method: "DELETE" });
  cache = null;
}
