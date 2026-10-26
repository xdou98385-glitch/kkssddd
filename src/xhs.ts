// 小红书：通过旁边另一个容器 xpzouying/xiaohongshu-mcp（无头浏览器 + 她扫码登录）的 HTTP 接口来读。
// 这里只做「读」：搜索、推荐流、笔记详情和评论、她自己的主页。点赞、评论、发帖这类写操作故意没接。
// 账号的登录态（cookie）只存在那个容器自己的数据卷里，这个应用不碰，也不存。
import * as db from "./db.ts";
import { cfg, onConfigChange } from "./config.ts";

const base = () => cfg("XHS_URL").replace(/\/+$/, "");
export let xhsEnabled = false; // 设置页改了配置会重新计算
const refresh = () => { xhsEnabled = base() !== ""; };
onConfigChange(refresh);
refresh();

const GAP_MS = Math.max(0, Number(process.env.XHS_GAP_SECONDS || 4)) * 1000; // 两次操作之间至少隔多久：像真人，也护着账号
const DAILY = Math.max(1, Number(process.env.XHS_DAILY_CALLS || 80) || 80); // 每天最多操作多少次

export class XhsError extends Error {}

const day = () => new Date().toISOString().slice(0, 10);
function usedToday(): number {
  try {
    const u = JSON.parse(db.getSetting("xhs_usage") || "{}");
    return u.day === day() ? Number(u.n) || 0 : 0;
  } catch { return 0; }
}

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

/** 所有请求排队，一个一个来，间隔 GAP_MS。无头浏览器本来也是一次只能干一件事 */
function queued<T>(fn: () => Promise<T>, gap = true): Promise<T> {
  const run = chain.then(async () => {
    const wait = gap ? lastAt + GAP_MS - Date.now() : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function call(path: string, init: RequestInit = {}, timeoutMs = 60_000, countIt = true): Promise<any> {
  if (!xhsEnabled) throw new XhsError("小红书还没配置");
  if (countIt && usedToday() >= DAILY) throw new XhsError(`今天对小红书的操作已经到上限了（${DAILY} 次），明天再来，免得账号被盯上`);
  return queued(async () => {
    const token = cfg("XHS_TOKEN");
    let res: Response;
    try {
      res = await fetch(base() + path, {
        ...init,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new XhsError("连不上小红书那个容器：" + (err as Error).message);
    }
    if (countIt) db.setSetting("xhs_usage", JSON.stringify({ day: day(), n: usedToday() + 1 }));
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 401) throw new XhsError("小红书容器的口令不对");
    if (!res.ok || body.success === false) throw new XhsError(String(body.error || body.message || `小红书服务出错 ${res.status}`));
    return body.data ?? body;
  }, countIt); // 查登录状态、拿二维码这类不算「刷帖子」，不用等间隔
}

// ---- 整理成给 Claude 读的文字（保持短，别把整个 JSON 灌给它）----
type Feed = { id?: string; xsecToken?: string; noteCard?: { displayTitle?: string; type?: string; user?: { nickname?: string; nickName?: string }; interactInfo?: Record<string, string>; video?: unknown } };

function feedLines(feeds: Feed[], limit = 12): string {
  if (!feeds?.length) return "（没有结果）";
  return feeds
    .slice(0, limit)
    .map((f, i) => {
      const c = f.noteCard ?? {};
      const it = c.interactInfo ?? {};
      const stats = [it.likedCount && `赞 ${it.likedCount}`, it.collectedCount && `藏 ${it.collectedCount}`, it.commentCount && `评 ${it.commentCount}`].filter(Boolean).join(" ");
      return `${i + 1}. ${c.displayTitle || "（无标题）"} | ${c.user?.nickname || c.user?.nickName || "?"} | ${c.video ? "视频" : "图文"}${stats ? " | " + stats : ""} | feed_id=${f.id} xsec_token=${f.xsecToken}`;
    })
    .join("\n");
}

export async function xhsSearch(keyword: string): Promise<string> {
  const d = await call("/api/v1/feeds/search", { method: "POST", body: JSON.stringify({ keyword: keyword.slice(0, 50) }) });
  return `搜「${keyword}」的结果（要看某一条详情，用它的 feed_id 和 xsec_token 调 xhs_note）：\n${feedLines(d.feeds)}`;
}

export async function xhsFeed(): Promise<string> {
  const d = await call("/api/v1/feeds/list");
  return `小红书推荐流（要看详情，用 feed_id 和 xsec_token 调 xhs_note）：\n${feedLines(d.feeds)}`;
}

export async function xhsNote(feedId: string, token: string): Promise<string> {
  const d = await call("/api/v1/feeds/detail", { method: "POST", body: JSON.stringify({ feed_id: feedId, xsec_token: token, load_all_comments: false }) }, 120_000);
  const note = d.data?.note ?? {};
  const it = note.interactInfo ?? {};
  const comments: any[] = d.data?.comments?.list ?? [];
  const lines = [
    `标题：${note.title || "（无）"}`,
    `作者：${note.user?.nickname || note.user?.nickName || "?"}${note.ipLocation ? "（" + note.ipLocation + "）" : ""}　类型：${note.type || "?"}　发布：${note.time ? new Date(note.time).toLocaleDateString("zh-CN") : "?"}`,
    `互动：赞 ${it.likedCount ?? "?"}　藏 ${it.collectedCount ?? "?"}　评 ${it.commentCount ?? "?"}　转 ${it.sharedCount ?? "?"}`,
    `正文：${String(note.desc || "（无文字）").slice(0, 1500)}`,
    comments.length ? "热门评论：" : "（没取到评论）",
    ...comments.slice(0, 10).map((c) => `- ${c.userInfo?.nickname || "?"}：${String(c.content).slice(0, 160)}（赞 ${c.likeCount ?? 0}${c.subCommentCount && c.subCommentCount !== "0" ? `，${c.subCommentCount} 条回复` : ""}）`),
  ];
  return lines.join("\n");
}

export async function xhsMe(): Promise<string> {
  const d = await call("/api/v1/user/me");
  const info = d.data?.userBasicInfo ?? d.userBasicInfo ?? {};
  const inter: any[] = d.data?.interactions ?? d.interactions ?? [];
  const notes: any[] = d.data?.feeds ?? d.feeds ?? [];
  return [
    `昵称：${info.nickname || "?"}　小红书号：${info.redId || "?"}　属地：${info.ipLocation || "?"}`,
    info.desc ? `简介：${info.desc}` : "",
    inter.length ? inter.map((i) => `${i.name} ${i.count}`).join("　") : "",
    notes.length ? "她的笔记：\n" + feedLines(notes, 10) : "",
  ].filter(Boolean).join("\n");
}

// ---- 设置页用 ----
export async function xhsStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!xhsEnabled) return { enabled: false };
  try {
    const d = await call("/api/v1/login/status", {}, 20_000, false);
    const s = d.data ?? d;
    return s.is_logged_in ? { enabled: true, ok: true, detail: `已登录${s.username ? "：" + s.username : ""}。今天已操作 ${usedToday()}/${DAILY} 次。` } : { enabled: true, ok: false, error: "容器连上了，但还没登录。点「登录二维码」，用小红书 app 扫一下。" };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}

export async function xhsQrcode(): Promise<{ img?: string; timeout?: string; loggedIn: boolean }> {
  const d = await call("/api/v1/login/qrcode", {}, 60_000, false);
  const s = d.data ?? d;
  return { img: s.img, timeout: s.timeout, loggedIn: Boolean(s.is_logged_in) };
}
