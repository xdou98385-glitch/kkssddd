// 她从抖音、小红书等 app 的「分享」里，用快捷指令发过来的内容。
// 不碰她的账号：只收分享出来的那段文字和链接，再尽量去读一下链接页面的标题和简介（只读公开页面）。
import * as db from "./db.ts";

export type Platform = "douyin" | "xiaohongshu" | "bilibili" | "weibo" | "other";

const HOSTS: [RegExp, Platform][] = [
  [/(^|\.)(douyin\.com|iesdouyin\.com|amemv\.com)$/, "douyin"],
  [/(^|\.)(xiaohongshu\.com|xhslink\.com)$/, "xiaohongshu"],
  [/(^|\.)(bilibili\.com|b23\.tv)$/, "bilibili"],
  [/(^|\.)(weibo\.com|weibo\.cn)$/, "weibo"],
];
const platformOf = (host: string): Platform | null => HOSTS.find(([re]) => re.test(host))?.[1] ?? null;

const URL_RE = /https?:\/\/[^\s，。！？）)】\]"'<>]+/;
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** 分享文字里常带一堆口令样的杂质（"5.12 复制打开抖音…  12/12 b@Q.eT :/"），清掉，留下有信息的部分 */
export function cleanShareText(raw: string): string {
  return clip(
    raw
      .replace(URL_RE, " ")
      .replace(/^\s*\d+\.\d+\s+/, "")
      .replace(/复制(此|本条)?(链接|信息)[，,]?\s*(打开|到)?[^\s，。]*(App|app|抖音|小红书)?[^\s]*/g, " ")
      .replace(/打开【?(抖音|小红书)】?(App|app)?(查看|直接观看)[^\s]*/g, " ")
      .replace(/\s\d{1,2}\/\d{1,2}\s+\S+@\S+\s*:?\/?/g, " ")
      .replace(/复制打开抖音[，,]?\s*看看/g, "")
      .replace(/[A-Za-z0-9]+@[A-Za-z0-9.]+\s*:?\/?/g, " "),
    500,
  );
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** 只读公开页面：只跟着白名单里的站点走（含重定向），防止被拿来访问内网 */
async function fetchMeta(url: string): Promise<{ title: string; desc: string; finalUrl: string }> {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(cur);
    if (!/^https?:$/.test(u.protocol) || !platformOf(u.hostname)) throw new Error("不在允许读取的站点里");
    const res = await fetch(cur, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); continue; }
    const html = (await res.text()).slice(0, 400_000);
    const pick = (re: RegExp) => decode(html.match(re)?.[1] ?? "").trim();
    const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || pick(/<title[^>]*>([^<]*)<\/title>/i);
    const desc = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    return { title: clip(title, 200), desc: clip(desc, 400), finalUrl: cur };
  }
  throw new Error("跳转太多次");
}

/** 记下一条分享。text 是分享出来的整段文字（可能带链接），url 是单独传来的链接（可选） */
export async function recordShare(input: { text?: string; url?: string }): Promise<{ id: number; platform: Platform; title: string }> {
  const raw = String(input.text ?? "").trim().slice(0, 3000);
  const url = (String(input.url ?? "").trim() || raw.match(URL_RE)?.[0] || "").slice(0, 500);
  if (!raw && !url) throw new Error("没有内容");
  let platform: Platform = "other";
  try { if (url) platform = platformOf(new URL(url).hostname) ?? "other"; } catch { /* 链接不合法就当没有 */ }
  let meta = { title: "", desc: "" };
  if (url && platform !== "other") {
    try { meta = await fetchMeta(url); } catch (err) { console.log(`share: 读不到页面信息（${(err as Error).message}），只用分享文字`); }
  }
  const text = cleanShareText(raw);
  const id = db.addShare({ platform, url, text, meta_title: meta.title, meta_desc: meta.desc });
  return { id, platform, title: meta.title || text.slice(0, 40) };
}

const NAME: Record<string, string> = { douyin: "抖音", xiaohongshu: "小红书", bilibili: "B站", weibo: "微博", other: "其他" };

export function describeShares(limit = 8, sinceMs = 0): string {
  const rows = db.recentShares(limit, sinceMs);
  if (!rows.length) return "";
  return rows
    .map((r) => {
      const when = new Date(r.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
      const parts = [r.meta_title && `标题：${r.meta_title}`, r.meta_desc && `简介：${r.meta_desc}`, r.text && `分享文字：${r.text}`, r.url && `链接：${r.url}`].filter(Boolean);
      return `- ${when} ${NAME[r.platform] ?? r.platform}：${parts.join("　") || "（没有内容）"}`;
    })
    .join("\n");
}
