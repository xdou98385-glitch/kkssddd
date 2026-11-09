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

async function allMemos(): Promise<Memo[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.memos;
  const memos: Memo[] = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ pageSize: "200" });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await memosFetch(`/api/v1/memos?${qs}`);
    for (const m of data.memos ?? [])
      memos.push({ name: m.name, content: String(m.content ?? ""), createTime: String(m.createTime ?? "") });
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  cache = { at: Date.now(), memos };
  return memos;
}

const day = (t: string) => t.slice(0, 10);
const fmt = (m: Memo) => `[${day(m.createTime)}] ${m.content.trim()}`;

/** 关键词搜索：按空格拆词，命中词越多越靠前，其次越新越靠前 */
export async function searchMemos(query: string, limit = 8): Promise<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "查询词是空的";
  const scored = (await allMemos())
    .map((m) => {
      const text = m.content.toLowerCase();
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
export interface MemoryItem { id: string; content: string; createTime: string; core: boolean; cat: string }

const TAG_RE = new RegExp(`(^|\\s)#(core|claude|${CATS.join("|")})(?=\\s|$)`, "g");
const plainOf = (c: string) => c.replace(TAG_RE, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const catOf = (c: string) => CATS.find((k) => new RegExp(`(^|\\s)#${k}(?=\\s|$)`).test(c)) ?? "";
const isCore = (c: string) => /(^|\s)#core(?=\s|$)/.test(c);
const compose = (text: string, cat: string, core: boolean) => [text, [cat && "#" + cat, core && "#core"].filter(Boolean).join(" ")].filter(Boolean).join("\n\n");
const idOf = (name: string) => name.replace(/^memos\//, "");
const check = (id: string) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("记忆编号不对"); return id; };

export async function listMemories(): Promise<MemoryItem[]> {
  cache = null; // 页面要看最新的
  return (await allMemos())
    .map((m) => ({ id: idOf(m.name), content: plainOf(m.content), createTime: m.createTime, core: isCore(m.content), cat: catOf(m.content) }))
    .sort((a, b) => b.createTime.localeCompare(a.createTime));
}

export async function addMemory(content: string, cat = ""): Promise<void> {
  const text = content.trim();
  if (!text) throw new Error("内容是空的");
  await memosFetch("/api/v1/memos", { method: "POST", body: JSON.stringify({ content: compose(text, (CATS as readonly string[]).includes(cat) ? cat : "", false), visibility: "PRIVATE" }) });
  cache = null;
}

/** 改正文、分类、钉住中的任意几样，没传的保持原样（标签自动保留） */
export async function updateMemory(id: string, patch: { content?: string; cat?: string; core?: boolean }): Promise<void> {
  const cur = (await listMemories()).find((x) => x.id === check(id));
  if (!cur) throw new Error("找不到这条记忆");
  const text = patch.content === undefined ? cur.content : patch.content.trim();
  if (!text) throw new Error("内容是空的，要删就点删除");
  const cat = patch.cat === undefined ? cur.cat : (CATS as readonly string[]).includes(patch.cat) ? patch.cat : "";
  await memosFetch(`/api/v1/memos/${id}?updateMask=content`, { method: "PATCH", body: JSON.stringify({ content: compose(text, cat, patch.core ?? cur.core) }) });
  cache = null;
}

export async function deleteMemory(id: string): Promise<void> {
  await memosFetch(`/api/v1/memos/${check(id)}`, { method: "DELETE" });
  cache = null;
}
