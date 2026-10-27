// 抖音：调旁边的 douyin 小服务（见 douyin/ 目录，基于 cv-cat/DouYin_Spider）。
// 默认只读。设置里「允许代我操作」填 on 后可点赞/收藏；发私信永远只起草，她点确认才发。发评论、发布作品没接。
// cookie 存在设置页「连接」里（只写不读），每次请求时带给小服务，小服务自己不存。
import * as db from "./db.ts";
import { cfg, onConfigChange } from "./config.ts";

const base = () => (cfg("DOUYIN_URL") || "http://127.0.0.1:18070").replace(/\/+$/, "");
export let douyinEnabled = false; // 填了 cookie 就算启用；设置页改了会重新计算
// 她粘进来的可能是：纯 cookie 串、带 "cookie: " 前缀的一行，或者 Chrome「Copy as cURL」整条命令。
// 三种都认，从里面取出 cookie 那一段。
export function extractCookie(raw: string): string {
  const v = raw.replace(/\s+/g, " ").trim();
  if (/^curl\b/i.test(v)) {
    const m =
      v.match(/(?:^|\s)(?:-b|--cookie)\s+\$?'([^']*)'/) ||
      v.match(/(?:^|\s)(?:-b|--cookie)\s+\$?"([^"]*)"/) ||
      v.match(/-H\s+\$?'cookie:\s*([^']*)'/i) ||
      v.match(/-H\s+\$?"cookie:\s*([^"]*)"/i);
    return m ? m[1].trim() : "";
  }
  return v.replace(/^cookie:\s*/i, "").trim();
}
const cookieValue = () => extractCookie(cfg("DOUYIN_COOKIE"));
const refresh = () => { douyinEnabled = cookieValue() !== ""; };
onConfigChange(refresh);
refresh();

const GAP_MS = Math.max(0, Number(process.env.DOUYIN_GAP_SECONDS || 5)) * 1000; // 两次操作之间至少隔多久
const DAILY = Math.max(1, Number(process.env.DOUYIN_DAILY_CALLS || 60) || 60); // 每天最多操作多少次

export class DouyinError extends Error {}

const day = () => new Date().toISOString().slice(0, 10);
function usedToday(): number {
  try {
    const u = JSON.parse(db.getSetting("douyin_usage") || "{}");
    return u.day === day() ? Number(u.n) || 0 : 0;
  } catch { return 0; }
}

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function call(path: string, body: Record<string, unknown> = {}, countIt = true, creds?: unknown): Promise<any> {
  const cookie = cookieValue();
  if (!cookie) throw new DouyinError("抖音还没配置 cookie");
  if (countIt && usedToday() >= DAILY) throw new DouyinError(`今天对抖音的操作已经到上限了（${DAILY} 次），明天再来，免得账号被盯上`);
  return queued(async () => {
    let res: Response;
    try {
      res = await fetch(base() + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, cookie, ...(creds ? { creds } : {}) }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      const e = err as Error;
      throw new DouyinError(e.name === "TimeoutError" ? "抖音小服务 90 秒没回话" : "连不上抖音小服务（它启动了吗？）：" + e.message);
    }
    if (countIt) db.setSetting("douyin_usage", JSON.stringify({ day: day(), n: usedToday() + 1 }));
    const out: any = await res.json().catch(() => ({}));
    if (!out.ok) throw new DouyinError(String(out.error || `抖音小服务出错 ${res.status}`));
    return out.data;
  });
}

type Item = { id?: string; desc?: string; author?: string; digg?: number | string; comment?: number | string; collect?: number | string; kind?: string; seconds?: number | null; topics?: string[] };

function lines(items: Item[] | undefined, limit = 12): string {
  if (!items?.length) return "（没有结果）";
  return items
    .slice(0, limit)
    .map((it, i) => {
      const stats = [it.digg != null && `赞 ${it.digg}`, it.comment != null && `评 ${it.comment}`, it.collect != null && `藏 ${it.collect}`].filter(Boolean).join(" ");
      const desc = (it.desc || "（无文字）").replace(/\s+/g, " ").slice(0, 80);
      return `${i + 1}. ${desc} | ${it.author || "?"} | ${it.kind || "视频"}${it.seconds ? ` ${it.seconds}秒` : ""}${stats ? " | " + stats : ""} | id=${it.id}`;
    })
    .join("\n");
}

export async function dyFeed(): Promise<string> {
  const d = await call("/feed", { count: 12 });
  return `抖音推荐流（看详情用 id 调 dy_work）：\n${lines(d.items)}${d.keys ? `\n（没解析出作品，接口返回的字段是：${d.keys.join(",")}）` : ""}`;
}

export async function dySearch(query: string): Promise<string> {
  const d = await call("/search", { query: query.slice(0, 50), count: 10 });
  return `搜「${query}」的结果（看详情用 id 调 dy_work）：\n${lines(d.items, 10)}`;
}

export async function dyLikes(): Promise<string> {
  const d = await call("/likes", { count: 12 });
  return `她最近点过赞的抖音：\n${lines(d.items)}`;
}

/** 作品 id、/video/<id> 链接，或分享出来的短链（v.douyin.com）。短链手动跟着重定向找 id，只走抖音的域名 */
export async function resolveWorkRef(input: string): Promise<string> {
  const t = input.trim();
  if (/^\d{10,}$/.test(t)) return t;
  const direct = (s: string) => s.match(/(?:video|note|slides)\/(\d{10,})/)?.[1] ?? s.match(/modal_id=(\d{10,})/)?.[1];
  const hit = direct(t);
  if (hit) return hit;
  let cur = t.match(/https?:\/\/[^\s，。！？）)】\]"'<>]+/)?.[0];
  if (!cur) throw new DouyinError("没认出作品 id 或链接");
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(cur);
    if (!/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(u.hostname)) throw new DouyinError("只能解析抖音的链接");
    const found = direct(cur);
    if (found) return found;
    const res = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }).catch(() => null);
    const loc = res?.headers.get("location");
    if (!loc) break;
    cur = new URL(loc, cur).toString();
    const f2 = direct(cur);
    if (f2) return f2;
  }
  throw new DouyinError("这个链接没解析出作品 id");
}

export async function dyWork(ref: string): Promise<string> {
  const id = await resolveWorkRef(ref);
  const d = await call("/work", { id });
  const it = d.item as (Item & { time?: number }) | null;
  if (!it) return `没取到这个作品：${d.note || "未知原因"}`;
  const cs: { user?: string; text?: string; digg?: number; replies?: number }[] = d.comments ?? [];
  return [
    `文字：${it.desc || "（无）"}`,
    `作者：${it.author || "?"}　类型：${it.kind}${it.seconds ? `，${it.seconds} 秒` : ""}　发布：${it.time ? new Date(it.time * 1000).toLocaleDateString("zh-CN") : "?"}`,
    `互动：赞 ${it.digg ?? "?"}　评 ${it.comment ?? "?"}　藏 ${it.collect ?? "?"}`,
    it.topics?.length ? `话题：${it.topics.join("、")}` : "",
    "（只能看到文字、数据和评论，看不到视频画面）",
    cs.length ? "热门评论：" : "（没取到评论）",
    ...cs.map((c) => `- ${c.user ?? "?"}：${String(c.text ?? "").slice(0, 160)}（赞 ${c.digg ?? 0}${c.replies ? `，${c.replies} 条回复` : ""}）`),
  ].filter(Boolean).join("\n");
}

// ---- 更多只读 ----
type User = { uid?: string | number; sec_uid?: string; nickname?: string; signature?: string; followers?: number };
const userLines = (us: User[] | undefined) =>
  us?.length ? us.map((u, i) => `${i + 1}. ${u.nickname || "?"} | uid=${u.uid}${u.followers != null ? ` | 粉丝 ${u.followers}` : ""}${u.signature ? ` | ${u.signature.replace(/\s+/g, " ")}` : ""}`).join("\n") : "（没有）";

export async function dyFollowers(): Promise<string> {
  return "关注她的人：\n" + userLines((await call("/followers", { count: 20 })).items);
}
export async function dyFollowing(): Promise<string> {
  return "她关注的人：\n" + userLines((await call("/following", { count: 20 })).items);
}
export async function dyCollects(): Promise<string> {
  const d = await call("/collects");
  const items = d.items as { name?: string; count?: number }[];
  if (!items?.length) return `没读到收藏夹${d.keys ? `（接口字段：${d.keys.join(",")}）` : ""}`;
  return "她的收藏夹（只能看到夹子名字和数量，看不到里面具体是什么）：\n" + items.map((c) => `- ${c.name}${c.count != null ? `（${c.count} 个）` : ""}`).join("\n");
}
export async function dyNotices(group: string): Promise<string> {
  const d = await call("/notices", { group, count: 15 });
  const items = d.items as { time?: number; text?: string }[];
  if (!items?.length) return "没有通知";
  return `她的抖音通知（${group}）：\n` + items.map((n) => `- ${n.time ? new Date(n.time * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) + " " : ""}${n.text}`).join("\n");
}
export async function dyComments(ref: string, withReplies: boolean): Promise<string> {
  const id = await resolveWorkRef(ref);
  const d = await call("/comments", { id, count: 15, with_replies: withReplies });
  const items = d.items as { user?: string; text?: string; digg?: number; replies_total?: number; replies?: { user?: string; text?: string }[] }[];
  if (!items?.length) return "没取到评论";
  return items
    .map((c) => [`- ${c.user ?? "?"}：${String(c.text ?? "").slice(0, 200)}（赞 ${c.digg ?? 0}${c.replies_total ? `，${c.replies_total} 条回复` : ""}）`, ...(c.replies ?? []).map((r) => `    ↳ ${r.user ?? "?"}：${String(r.text ?? "").slice(0, 120)}`)].join("\n"))
    .join("\n");
}
/** 听一小会儿新私信：只收这段时间进来的，看不到历史 */
export async function dyDmListen(seconds: number): Promise<string> {
  const d = await call("/dm_recv", { seconds });
  const items = d.items as { from?: string | number; text?: string }[];
  return items?.length
    ? `听了 ${d.listened} 秒，收到：\n` + items.map((m) => `- 来自 ${m.from}：${m.text}`).join("\n")
    : `听了 ${d.listened} 秒，没有新私信（接口只推送这段时间进来的，看不到历史私信）`;
}

// ---- 写操作 ----
export const douyinActionsOn = () => cfg("DOUYIN_ACTIONS").trim().toLowerCase() === "on";
const WRITE_DAILY = Math.max(1, Number(process.env.DOUYIN_WRITE_DAILY || 30) || 30);
function writeGuard(): void {
  if (!douyinActionsOn()) throw new DouyinError("设置里没打开「允许代我操作」，所以不能点赞/收藏/发私信");
  let u: { day?: string; n?: number } = {};
  try { u = JSON.parse(db.getSetting("douyin_writes") || "{}"); } catch { /* 忽略 */ }
  const n = u.day === day() ? Number(u.n) || 0 : 0;
  if (n >= WRITE_DAILY) throw new DouyinError(`今天代她做的操作已经到上限了（${WRITE_DAILY} 次）`);
  db.setSetting("douyin_writes", JSON.stringify({ day: day(), n: n + 1 }));
}
export async function dyLike(ref: string, undo: boolean): Promise<string> {
  writeGuard();
  await call("/digg", { id: await resolveWorkRef(ref), undo }, true, browserCreds(false));
  return undo ? "已取消点赞" : "已点赞";
}
export async function dyCollect(ref: string, undo: boolean): Promise<string> {
  writeGuard();
  await call("/collect", { id: await resolveWorkRef(ref), undo }, true, browserCreds(false));
  return undo ? "已取消收藏" : "已收藏";
}
/** 浏览器凭据：控制台脚本打包出来的 JSON（localStorage 里 security-sdk 的几项），只在发评论时带给小服务 */
function browserCreds(required = true): unknown {
  const raw = cfg("DOUYIN_BROWSER").trim();
  const dtrait = cfg("DOUYIN_DTRAIT").trim();
  let obj: Record<string, unknown> = {};
  if (raw) {
    try { obj = JSON.parse(raw); } catch { throw new DouyinError("「浏览器凭据」不是有效的 JSON，请重新用控制台脚本取一遍"); }
  } else if (required) throw new DouyinError("还没填「浏览器凭据」，发评论需要它（设置 → 连接 → 抖音）");
  if (dtrait) obj = { ...obj, dtrait_blob: dtrait };
  return Object.keys(obj).length ? obj : undefined;
}
/** 评论只起草：存起来等她确认 */
export async function dyCommentDraft(ref: string, text: string, replyId: string): Promise<string> {
  if (!douyinActionsOn()) throw new DouyinError("设置里没打开「允许代我操作」，所以不能发评论");
  browserCreds();
  const t = text.trim().slice(0, 140);
  if (!t) throw new DouyinError("评论内容是空的");
  const id = await resolveWorkRef(ref);
  const pid = db.addPending("dy_comment", `${replyId ? "回复评论" : "评论"}（作品 ${id}）：${t}`, { id, text: t, reply_id: replyId });
  return `已起草，等她在聊天界面点「发送」确认后才会真发出去（草稿 #${pid}）。别说已经发了。`;
}
/** 私信只起草：存起来等她在聊天里确认，不会直接发 */
export function dyDmDraft(toUid: string, toName: string, text: string): string {
  if (!douyinActionsOn()) throw new DouyinError("设置里没打开「允许代我操作」，所以不能发私信");
  if (!/^\d{5,}$/.test(toUid)) throw new DouyinError("to_uid 要是纯数字的用户 uid（从关注/粉丝列表里拿）");
  const t = text.trim().slice(0, 500);
  if (!t) throw new DouyinError("私信内容是空的");
  const id = db.addPending("dy_dm", `发私信给「${toName || toUid}」：${t}`, { to_uid: toUid, text: t });
  return `已起草，等她在聊天界面点「发送」确认后才会真发出去（草稿 #${id}）。别说已经发了。`;
}
export async function runPending(id: number): Promise<string> {
  const p = db.getPending(id);
  if (!p || p.status !== "pending") throw new DouyinError("这条草稿已经处理过了");
  if (p.kind !== "dy_dm" && p.kind !== "dy_comment") throw new DouyinError("不认识的草稿类型");
  const payload = JSON.parse(p.payload) as { to_uid?: string; text: string; id?: string; reply_id?: string };
  const creds = p.kind === "dy_comment" ? browserCreds() : undefined;
  writeGuard();
  db.setPendingStatus(id, "sending");
  try {
    if (p.kind === "dy_dm") await call("/dm_send", { to_uid: payload.to_uid, text: payload.text }, true, browserCreds(false));
    else await call("/comment_post", { id: payload.id, text: payload.text, reply_id: payload.reply_id }, true, creds);
  } catch (err) {
    db.setPendingStatus(id, "pending"); // 失败了留着，她可以再试或丢掉
    throw err;
  }
  db.setPendingStatus(id, "done");
  return p.kind === "dy_dm" ? "私信已发送" : "评论已发送";
}

// ---- 设置页用 ----
/** 体检：每个只读功能各试一遍（会算几次操作），哪个通、哪个不通、为什么，一次说清 */
export async function douyinProbe(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!douyinEnabled) return { enabled: false };
  try {
    const d = await call("/probe", {}, true);
    const names: Record<string, string> = { whoami: "登录", feed: "推荐流", search: "搜索", likes: "点赞列表" };
    const rows = Object.entries(d as Record<string, { ok: boolean; n?: number; via?: string; error?: string }>).map(
      ([k, v]) => `${v.ok ? "✓" : "✗"} ${names[k] ?? k}${v.ok ? (v.n != null ? `（读到 ${v.n} 条${v.via ? "，走 " + v.via : ""}）` : "") : "：" + (v.error ?? "失败")}`,
    );
    const allOk = Object.values(d as Record<string, { ok: boolean }>).every((v) => v.ok);
    return { enabled: true, ok: allOk, detail: rows.join("\n"), error: allOk ? undefined : rows.join("\n") };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}

export async function douyinStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!douyinEnabled) return { enabled: false };
  try {
    const d = await call("/whoami", {}, false);
    if (d.has_session === false) return { enabled: true, ok: false, error: "这份 cookie 里没有登录凭据（sessionid / sid_guard），是游客 cookie：能看推荐流，但搜索、点赞、评论都不行。请在【已登录】的抖音网页里重新取一次 cookie（取之前先确认页面右上角是你的头像）" };
    return { enabled: true, ok: true, detail: `cookie 有效。账号：${d.nickname || "（昵称没读到）"}${d.followers != null ? ` · 粉丝 ${d.followers}` : ""}。今天已操作 ${usedToday()}/${DAILY} 次。${d.note ? " " + d.note : ""}` };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}
