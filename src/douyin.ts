// 抖音（只读）：调旁边的 douyin 小服务（见 douyin/ 目录，基于 cv-cat/DouYin_Spider）。
// 只做「看」：推荐流、搜索、一个作品的详情和热门评论、她点过赞的视频。点赞、评论、私信、发布都没接。
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

async function call(path: string, body: Record<string, unknown> = {}, countIt = true): Promise<any> {
  const cookie = cookieValue();
  if (!cookie) throw new DouyinError("抖音还没配置 cookie");
  if (countIt && usedToday() >= DAILY) throw new DouyinError(`今天对抖音的操作已经到上限了（${DAILY} 次），明天再来，免得账号被盯上`);
  return queued(async () => {
    let res: Response;
    try {
      res = await fetch(base() + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, cookie }),
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

// ---- 设置页用 ----
export async function douyinStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!douyinEnabled) return { enabled: false };
  try {
    const d = await call("/whoami", {}, false);
    return { enabled: true, ok: true, detail: `cookie 有效。账号：${d.nickname || "（昵称没读到）"}${d.followers != null ? ` · 粉丝 ${d.followers}` : ""}。今天已操作 ${usedToday()}/${DAILY} 次。${d.note ? " " + d.note : ""}` };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}
