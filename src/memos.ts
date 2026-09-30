// Memos 记忆后端。只用 v0.22+ 的公开接口：GET/POST /api/v1/memos，Bearer token。
const base = (process.env.MEMOS_URL ?? "").replace(/\/+$/, "");
const token = process.env.MEMOS_TOKEN ?? "";

export const memosEnabled = base !== "" && token !== "";

export interface Memo {
  name: string;
  content: string;
  createTime: string;
}

async function memosFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(base + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

export async function saveMemo(content: string): Promise<string> {
  const text = content.trim();
  if (!text) throw new Error("内容是空的");
  await memosFetch("/api/v1/memos", {
    method: "POST",
    body: JSON.stringify({ content: `#claude ${text}`, visibility: "PRIVATE" }),
  });
  cache = null;
  return "已保存";
}

/** 带 #core 标签的笔记会在每次对话开头自动读进去，用来放最重要的长期信息 */
export async function coreMemories(): Promise<string> {
  const core = (await allMemos()).filter((m) => /(^|\s)#core(\s|$)/.test(m.content));
  return core.map((m) => m.content.replace(/(^|\s)#core(?=\s|$)/g, "").trim()).join("\n---\n");
}
